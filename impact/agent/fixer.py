"""Asks the local model for a patch, and for a revision when Impact finds a problem."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..ports import LLM
from ..report import Report
from . import edits

MAX_CONTEXT_CHARS = 12_000
IGNORED = {".git", ".venv", "venv", "__pycache__", ".pytest_cache"}

RULES = """You are a careful coding agent. Fix only what the user asks. Make the smallest change.
Reply in exactly this format, nothing else:

EXPLANATION: <one or two sentences>

FILE: <path>
<<<<<<< SEARCH
<exact lines copied from the file>
=======
<replacement lines>
>>>>>>> REPLACE

You may use several FILE blocks. SEARCH must match the file exactly."""


@dataclass(frozen=True)
class Proposal:
    explanation: str
    diff: str


class Fixer:
    def __init__(self, llm: LLM):
        self.llm = llm

    def propose(self, repo: Path, request: str) -> Proposal:
        prompt = f"{RULES}\n\n{context(repo)}\n\nUSER REQUEST: {request}\n"
        return self._ask(repo, prompt)

    def revise(self, repo: Path, request: str, previous: Proposal, report: Report) -> Proposal:
        prompt = (f"{context(repo)}\n\nUSER REQUEST: {request}\n\n"
                  f"A PREVIOUS PATCH WAS REJECTED:\n{previous.diff}\n"
                  f"WHY IT WAS REJECTED (impact analysis):\n{feedback(report)}\n\n"
                  "Write a corrected patch against the ORIGINAL files above. "
                  f"Do not reason step by step; the explanation is one sentence.\n\n{RULES}\n")
        return self._ask(repo, prompt)

    def _ask(self, repo: Path, prompt: str) -> Proposal:
        explanation, found = edits.parse(self.llm.complete(prompt))
        return Proposal(explanation, edits.to_diff(repo, found))


def context(repo: Path) -> str:
    """Repo files for the prompt, source before tests, within a size budget."""
    files = sorted((p for p in repo.rglob("*.py") if not IGNORED.intersection(p.relative_to(repo).parts)),
                   key=lambda p: (p.name.startswith("test_"), p.as_posix()))
    parts, size = [], 0
    for p in files:
        block = f"--- {p.relative_to(repo).as_posix()} ---\n{p.read_text()}"
        if size + len(block) > MAX_CONTEXT_CHARS:
            break
        parts.append(block)
        size += len(block)
    return "REPOSITORY FILES:\n\n" + "\n".join(parts)


def feedback(r: Report) -> str:
    """What the model needs to know: which tests broke, how they depend on the change, and the error."""
    lines = []
    for t in r.regressions:
        how = " -> ".join(t.path) if t.path else "runtime coverage"
        lines.append(f"- {t.scope} test {t.nodeid} FAILED: {t.message.splitlines()[0] if t.message else ''}\n"
                     f"  dependency path: {how}")
    passed = [t.nodeid for t in r.tests if t.status == "passed"]
    if passed:
        lines.append(f"- these tests passed and must keep passing: {', '.join(passed)}")
    if r.gaps:
        lines.append(f"- affected but untested: {', '.join(r.gaps)}")
    return "\n".join(lines)
