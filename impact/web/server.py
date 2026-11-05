"""Impact Review UI. One review session at a time; stdlib HTTP server, static files, JSON API."""
from __future__ import annotations

import json
import shutil
import threading
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from ..agent.edits import EditError
from ..agent.fixer import Fixer, Proposal
from ..pipeline import ImpactAnalyzer
from ..report import Report
from ..workspace import IGNORE, PatchError, apply_patch

STATIC = Path(__file__).resolve().parent / "static"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}
MAX_BODY = 20_000


@dataclass
class Attempt:
    source: str  # agent | revision | simulated
    explanation: str
    diff: str
    report: Report

    def to_dict(self) -> dict:
        return {"source": self.source, "explanation": self.explanation, "diff": self.diff,
                "report": self.report.to_dict()}


@dataclass
class Session:
    request: str = ""
    attempts: list[Attempt] = field(default_factory=list)
    approved: bool = False


class ReviewApp:
    def __init__(self, repo: Path, seed: Path | None, analyzer: ImpactAnalyzer, fixer: Fixer,
                 simulated_patch: Path | None, model: str):
        self.repo, self.seed, self.analyzer, self.fixer = repo, seed, analyzer, fixer
        self.simulated_patch, self.model = simulated_patch, model
        self.session = Session()
        self.lock = threading.Lock()
        if seed and not repo.exists():
            self.reset()

    def state(self) -> dict:
        return {"repo": self.repo.name, "model": self.model, "request": self.session.request,
                "approved": self.session.approved, "can_simulate": bool(self.simulated_patch),
                "can_reset": bool(self.seed), "attempts": [a.to_dict() for a in self.session.attempts]}

    def _record(self, source: str, proposal: Proposal) -> dict:
        report = self.analyzer.analyze(self.repo, proposal.diff)
        self.session.attempts.append(Attempt(source, proposal.explanation, proposal.diff, report))
        return self.state()

    def ask(self, request: str) -> dict:
        self.session = Session(request=request)
        return self._record("agent", self.fixer.propose(self.repo, request))

    def simulate(self, request: str) -> dict:
        self.session = Session(request=request)
        proposal = Proposal("Simulated plausible fix: corrects the percentage and rounds the result.",
                            self.simulated_patch.read_text())
        return self._record("simulated", proposal)

    def revise(self) -> dict:
        if not self.session.attempts:
            raise ValueError("nothing to revise")
        last = self.session.attempts[-1]
        proposal = self.fixer.revise(self.repo, self.session.request,
                                     Proposal(last.explanation, last.diff), last.report)
        return self._record("revision", proposal)

    def approve(self) -> dict:
        if not self.session.attempts or self.session.approved:
            raise ValueError("nothing to approve")
        apply_patch(self.repo, self.session.attempts[-1].diff)
        self.session.approved = True
        return self.state()

    def reset(self) -> dict:
        if not self.seed:
            raise ValueError("no seed repo configured")
        if self.repo.exists():
            shutil.rmtree(self.repo)
        shutil.copytree(self.seed, self.repo, ignore=IGNORE)
        self.session = Session()
        return self.state()


def make_handler(app: ReviewApp):
    actions = {"/api/ask": lambda b: app.ask(_require(b, "request")),
               "/api/simulate": lambda b: app.simulate(b.get("request") or "The receipt total is way too high."),
               "/api/revise": lambda b: app.revise(),
               "/api/approve": lambda b: app.approve(),
               "/api/reset": lambda b: app.reset()}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, status: int, body: bytes, ctype: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, data: dict) -> None:
            self._send(status, json.dumps(data).encode(), "application/json")

        def do_GET(self):
            if self.path == "/api/state":
                return self._json(200, app.state())
            name = "index.html" if self.path == "/" else self.path.lstrip("/")
            path = (STATIC / name).resolve()
            if not path.is_relative_to(STATIC) or not path.is_file():
                return self._send(404, b"not found", "text/plain")
            self._send(200, path.read_bytes(), TYPES.get(path.suffix, "application/octet-stream"))

        def do_POST(self):
            action = actions.get(self.path)
            if not action:
                return self._json(404, {"error": "unknown endpoint"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._json(413, {"error": "request too large"})
            body = json.loads(self.rfile.read(length) or b"{}")
            if not app.lock.acquire(blocking=False):
                return self._json(409, {"error": "busy with another request"})
            try:
                self._json(200, action(body))
            except (EditError, PatchError, ValueError) as e:
                self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(e)})
            except Exception as e:  # noqa: BLE001 - surface anything else to the page
                self._json(500, {"error": f"{type(e).__name__}: {e}"})
            finally:
                app.lock.release()

    return Handler


def _require(body: dict, key: str) -> str:
    value = (body.get(key) or "").strip()
    if not value:
        raise ValueError(f"missing {key}")
    return value


def serve(app: ReviewApp, port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    print(f"Impact Review on http://127.0.0.1:{port}  (repo: {app.repo})")
    server.serve_forever()
