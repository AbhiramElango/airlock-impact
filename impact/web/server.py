"""Impact Review UI server. One review session at a time; jobs run in a background thread and
record their steps, which the page polls to show the agent's work live."""
from __future__ import annotations

import json
import shutil
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from ..agent.fixer import Fixer, Proposal, feedback
from ..pipeline import ImpactAnalyzer
from ..report import Report
from ..workspace import IGNORE, apply_patch

STATIC = Path(__file__).resolve().parent / "static"
TYPES = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml"}
MAX_BODY = 20_000
SOURCE_SUFFIXES = {".py", ".md", ".txt", ".toml", ".cfg", ".ini", ".json", ".yaml", ".yml"}


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
class Step:
    attempt: int
    key: str
    label: str
    status: str = "running"  # running | done | failed
    detail: str = ""
    started: float = field(default_factory=time.monotonic)
    seconds: float | None = None


class StepLog:
    """Progress implementation that records steps for the page to poll."""

    def __init__(self, session: Session):
        self.session = session

    def start(self, key: str, label: str) -> None:
        self.session.steps.append(Step(len(self.session.attempts), key, label))

    def done(self, key: str, detail: str = "", ok: bool = True) -> None:
        step = next(s for s in reversed(self.session.steps) if s.key == key)
        step.status, step.detail = ("done" if ok else "failed"), detail
        step.seconds = round(time.monotonic() - step.started, 1)


@dataclass
class Session:
    request: str = ""
    attempts: list[Attempt] = field(default_factory=list)
    steps: list[Step] = field(default_factory=list)
    busy: bool = False
    error: str = ""
    approved: bool = False


class ReviewApp:
    def __init__(self, repo: Path, seed: Path | None, analyzer: ImpactAnalyzer, fixer: Fixer,
                 simulated_patch: Path | None, model: str, store: str):
        self.repo, self.seed, self.analyzer, self.fixer = repo, seed, analyzer, fixer
        self.simulated_patch, self.model, self.store = simulated_patch, model, store
        self.session = Session()
        self.lock = threading.Lock()
        if seed:
            self._reset_files()  # every server start begins from the pristine demo

    # read side
    def state(self) -> dict:
        s = self.session
        return {"repo": self.repo.name, "model": self.model, "store": self.store, "request": s.request,
                "busy": s.busy, "error": s.error, "approved": s.approved,
                "can_simulate": bool(self.simulated_patch), "can_reset": bool(self.seed),
                "attempts": [a.to_dict() for a in s.attempts],
                "steps": [{"attempt": st.attempt, "key": st.key, "label": st.label, "status": st.status,
                           "detail": st.detail, "seconds": st.seconds} for st in s.steps]}

    def files(self) -> list[str]:
        return sorted(p.relative_to(self.repo).as_posix() for p in self.repo.rglob("*")
                      if p.is_file() and p.suffix in SOURCE_SUFFIXES
                      and not {".git", "__pycache__", ".venv"}.intersection(p.relative_to(self.repo).parts))

    def file(self, rel: str) -> str:
        path = (self.repo / rel).resolve()
        if not path.is_relative_to(self.repo.resolve()) or not path.is_file():
            raise ValueError(f"unknown file: {rel}")
        return path.read_text()

    # write side: each action starts a background job
    def start(self, action: str, body: dict) -> dict:
        jobs: dict[str, Callable[[], None]] = {
            "ask": lambda: self._ask((body.get("request") or "").strip()),
            "simulate": lambda: self._simulate((body.get("request") or "").strip()),
            "revise": self._revise,
        }
        if action == "approve":
            return self._approve()
        if action == "reset":
            return self._reset()
        if action not in jobs:
            raise ValueError("unknown action")
        with self.lock:
            if self.session.busy:
                raise ValueError("busy with another request")
            if action in ("ask", "simulate"):
                self.session = Session(request=(body.get("request") or "").strip() or "Fix the bug.")
            self.session.busy, self.session.error = True, ""
        threading.Thread(target=self._run, args=(jobs[action],), daemon=True).start()
        return self.state()

    def _run(self, job: Callable[[], None]) -> None:
        try:
            job()
        except Exception as e:  # noqa: BLE001 - shown in the page
            self.session.error = f"{type(e).__name__}: {e}"
            for st in self.session.steps:
                if st.status == "running":
                    st.status, st.detail = "failed", str(e)[:200]
        finally:
            self.session.busy = False

    def _analyze(self, source: str, proposal: Proposal) -> None:
        log = StepLog(self.session)
        report = self.analyzer.analyze(self.repo, proposal.diff, log)
        log.start("verdict", "Verdict")
        log.done("verdict", report.verdict, ok=report.verdict != "regression")
        self.session.attempts.append(Attempt(source, proposal.explanation, proposal.diff, report))

    def _ask(self, request: str) -> None:
        log = StepLog(self.session)
        log.start("patch", f"Local model ({self.model}) writes a patch")
        proposal = self.fixer.propose(self.repo, request)
        log.done("patch", proposal.explanation)
        self._analyze("agent", proposal)

    def _simulate(self, request: str) -> None:
        log = StepLog(self.session)
        log.start("patch", "Simulated agent patch (plausible bad fix)")
        proposal = Proposal("Divides the percentage by 100 and rounds the result.",
                            self.simulated_patch.read_text())
        log.done("patch", proposal.explanation)
        self._analyze("simulated", proposal)

    def _revise(self) -> None:
        if not self.session.attempts:
            raise ValueError("nothing to revise")
        last = self.session.attempts[-1]
        log = StepLog(self.session)
        log.start("feedback", "Send impact evidence back to the agent")
        log.done("feedback", feedback(last.report).splitlines()[0] if last.report.tests else "")
        log.start("patch", f"Local model ({self.model}) revises the patch")
        proposal = self.fixer.revise(self.repo, self.session.request, Proposal(last.explanation, last.diff),
                                     last.report)
        log.done("patch", proposal.explanation)
        self._analyze("revision", proposal)

    def _approve(self) -> dict:
        with self.lock:
            s = self.session
            if s.busy or not s.attempts or s.approved:
                raise ValueError("nothing to approve")
            apply_patch(self.repo, s.attempts[-1].diff)
            s.approved = True
            s.steps.append(Step(len(s.attempts) - 1, "approve", "Human approved · patch applied to repo",
                                "done", "", time.monotonic(), 0.0))
        return self.state()

    def _reset(self) -> dict:
        with self.lock:
            if self.session.busy:
                raise ValueError("busy with another request")
            self._reset_files()
            self.session = Session()
        return self.state()

    def _reset_files(self) -> None:
        if not self.seed:
            raise ValueError("no seed repo configured")
        if self.repo.exists():
            shutil.rmtree(self.repo)
        shutil.copytree(self.seed, self.repo, ignore=IGNORE)


def make_handler(app: ReviewApp):
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

        def _json(self, status: int, data) -> None:
            self._send(status, json.dumps(data).encode(), "application/json")

        def do_GET(self):
            url = urlparse(self.path)
            try:
                if url.path == "/api/state":
                    return self._json(200, app.state())
                if url.path == "/api/files":
                    return self._json(200, app.files())
                if url.path == "/api/file":
                    return self._json(200, {"text": app.file(parse_qs(url.query).get("path", [""])[0])})
            except ValueError as e:
                return self._json(404, {"error": str(e)})
            name = "index.html" if url.path == "/" else url.path.lstrip("/")
            path = (STATIC / name).resolve()
            if not path.is_relative_to(STATIC) or not path.is_file():
                return self._send(404, b"not found", "text/plain")
            self._send(200, path.read_bytes(), TYPES.get(path.suffix, "application/octet-stream"))

        def do_POST(self):
            url = urlparse(self.path)
            if not url.path.startswith("/api/"):
                return self._json(404, {"error": "unknown endpoint"})
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._json(413, {"error": "request too large"})
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
                self._json(200, app.start(url.path.removeprefix("/api/"), body))
            except ValueError as e:
                self._json(409, {"error": str(e)})

    return Handler


def serve(app: ReviewApp, port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(app))
    print(f"Impact Review on http://127.0.0.1:{port}  (repo: {app.repo})")
    server.serve_forever()
