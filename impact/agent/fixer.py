"""Asks the local model for a patch, and for a revision when Impact finds a problem."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..ports import LLM
from ..report import Report
from ..workspace import apply_patch, scratch_copy
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

    def revise(self, repo: Path, request: str, previous: Proposal, report: Report,
               locked: set[str] | None = None) -> Proposal:
        """Graph guardrail: shared code whose change broke other callers is locked, and the model writes a
        fresh fix against the original files that leaves it untouched."""
        locked = (locked or set()) | locked_symbols(report)
        locked_files = {n["file"] for n in report.graph.get("nodes", []) if n["id"] in locked}
        prompt = (f"{context(repo)}\n\nUSER REQUEST: {request}\n\n"
                  f"A PREVIOUS FIX WAS REJECTED. IMPACT ANALYSIS:\n{feedback(report)}\n\n"
                  f"{dependent_code(repo, report)}"
                  + (f"LOCKED: {', '.join(sorted(locked))} in {', '.join(sorted(locked_files))}. This code was correct "
                     "before your change and other code relies on it. Do NOT edit "
                     f"{', '.join(sorted(locked_files))}. Fix the bug in the remaining code instead.\n" if locked else "")
                  + "Do not edit test files. Do not reason step by step; the explanation is one sentence.\n\n"
                  f"{RULES}\n")
        for _ in range(2):  # one retry if the model touches what the graph locked
            explanation, found = edits.parse(self.llm.complete(prompt))
            bad = sorted({e.file for e in found if e.file in locked_files or Path(e.file).name.startswith("test_")})
            if not bad:
                return Proposal(explanation, edits.to_diff(repo, found))
            prompt += (f"\nREJECTED: your edit changed {', '.join(bad)}, which is locked. "
                       "Leave it exactly as it is and change only the code that uses it.\n")
        raise edits.EditError(f"revision kept editing locked files: {', '.join(bad)}")

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


def locked_symbols(r: Report) -> set[str]:
    """Shared symbols whose change broke a test through another caller, plus those broken callers:
    they were correct before the change (victims, not the bug), so a revision must not touch them."""
    changed = {c.id for c in r.changed}
    locked = set()
    for t in r.regressions:
        if t.path and t.path[-1] in changed and len(t.path) > 2:
            locked.add(t.path[-1])
            locked.update(t.path[1:-1])
    return locked


def original_code(repo: Path, r: Report) -> str:
    """The changed functions as they were before the patch (repo is the unpatched original)."""
    nodes = {n["id"]: n for n in r.graph.get("nodes", [])}
    blocks = []
    for c in r.changed:
        n = nodes.get(c.id)
        if n and n["kind"] == "Function":
            text = (repo / n["file"]).read_text().splitlines()
            blocks.append(f"# {c.id} BEFORE your change ({n['file']}):\n" + "\n".join(text[n["start"] - 1:n["end"]]))
    return "\n".join(blocks) + "\n\n" if blocks else ""


def dependent_code(repo: Path, r: Report) -> str:
    """Graph evidence: every function that depends on the changed code, with its source, so the model can
    see what callers expect. Changing a shared function's behavior breaks all of them."""
    nodes = {n["id"]: n for n in r.graph.get("nodes", [])}
    broken = {sym for t in r.regressions for sym in t.path[1:-1]}
    blocks = []
    for d in r.impacted:
        n = nodes.get(d.id)
        if not n or n["kind"] != "Function":
            continue
        lines = (repo / n["file"]).read_text().splitlines()[n["start"] - 1:n["end"]]
        status = "BROKEN by the previous patch" if d.id in broken else "depends on it"
        blocks.append(f"# {d.id} ({n['file']}), {d.hops} hop(s) from the change, {status}\n" + "\n".join(lines))
    if not blocks:
        return ""
    changed = ", ".join(c.id for c in r.changed)
    return (f"CODE THAT DEPENDS ON {changed} (from the dependency graph). Its current behavior is relied on "
            f"by all of these; keep them working:\n" + "\n\n".join(blocks) + "\n\n")
