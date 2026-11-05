"""Closes test gaps the impact analysis found: the model writes tests, we place them in the right file."""
from __future__ import annotations

import ast
import re
from pathlib import Path

from ..report import Report
from ..workspace import apply_patch, scratch_copy
from . import edits
from .fixer import Proposal, context

CODE_BLOCK = re.compile(r"```(?:python)?\n(.*?)```", re.S)

PROMPT = """{context}

The patch below has been applied to the files above, and all selected tests pass:
{diff}
Impact analysis walked the dependency graph from the change and found affected functions
that NO test exercises:
{gaps}

Write pytest tests ONLY for the functions listed above, checking their behavior with the patch
applied. Do not repeat what existing tests already check. They will be appended to {test_file}.
Assert on the values that matter (amounts, totals). For text output, check that the key values
appear in it (e.g. `assert "19.98" in text`), not exact spacing. Compute expected values from the code.
{retry}

Reply in exactly this format:
EXPLANATION: <one sentence>

```python
<imports>

<test functions>
```
"""


class TestWriter:
    __test__ = False  # not a pytest test class
    def __init__(self, llm):
        self.llm = llm

    def cover(self, repo: Path, current: Proposal, report: Report,
              failed: tuple[str, str] | None = None) -> tuple[Proposal, str]:
        """Returns (fix + new tests as one patch, the test code). `failed` = (previous test code,
        failure message), so the model can correct its own test."""
        if not report.gaps:
            raise ValueError("no untested code to cover")
        work = scratch_copy(repo, "gaps")
        apply_patch(work, current.diff)
        test_file = self._test_file(work, report.gaps[0])
        reply = self.llm.complete(PROMPT.format(
            context=context(work), diff=current.diff, gaps=_describe(report), test_file=test_file,
            retry=f"\nYOUR PREVIOUS TESTS FAILED:\n{failed[0]}\nFAILURE: {failed[1]}\nFix the tests, not the code.\n"
            if failed else ""))

        explanation = (re.search(r"EXPLANATION:\s*(.+)", reply) or [None, "Adds tests for untested code."])[1].strip()
        block = CODE_BLOCK.search(reply)
        if not block:
            raise edits.EditError("model returned no test code")
        code = block.group(1)
        tree = ast.parse(code)  # SyntaxError surfaces to the UI
        if not any(isinstance(n, ast.FunctionDef) and n.name.startswith("test") for n in tree.body):
            raise edits.EditError("model returned no test functions")

        target = work / test_file
        before_test = (repo / test_file).read_text() if (repo / test_file).exists() else ""
        target.write_text(_merge(target.read_text() if target.exists() else "", code))

        changes = {f: ((repo / f).read_text(), (work / f).read_text()) for f in _diff_files(current.diff)}
        changes[test_file] = (before_test, target.read_text())
        return Proposal(explanation, edits.unified(changes)), code

    @staticmethod
    def _test_file(work: Path, symbol: str) -> str:
        """Tests for module `receipt` live in test_receipt.py next to it (pytest convention)."""
        module = symbol.split(".")[0]
        return f"test_{module.replace('.', '/')}.py"


def _describe(report: Report) -> str:
    paths = {i.id: i.path for i in report.impacted}
    nodes = {n["id"]: n for n in report.graph.get("nodes", [])}
    lines = []
    for g in report.gaps:
        n = nodes.get(g, {})
        via = " -> ".join(paths.get(g, [])) or "changed directly"
        lines.append(f"- {g} ({n.get('file', '?')}:{n.get('start', '?')}), affected via {via}")
    return "\n".join(lines)


def _diff_files(diff: str) -> list[str]:
    return [l[6:] for l in diff.splitlines() if l.startswith("+++ b/")]


IMPORT = re.compile(r"^(?:from (\S+) )?import (.+)$")


def _merge(existing: str, code: str) -> str:
    """Imports are merged into the existing import block; new tests go at the end of the file."""
    new_imports, body = [], []
    for line in code.strip("\n").splitlines():
        if not body and (IMPORT.match(line) or not line.strip()):
            if line.strip():
                new_imports.append(line)
        else:
            body.append(line)
    lines = existing.rstrip("\n").splitlines()
    for imp in new_imports:
        module, names = IMPORT.match(imp).groups()
        same = next((i for i, l in enumerate(lines) if module and l.startswith(f"from {module} import ")), None)
        if same is not None:
            have = [n.strip() for n in lines[same].split(" import ", 1)[1].split(",")]
            merged = have + [n.strip() for n in names.split(",") if n.strip() not in have]
            lines[same] = f"from {module} import {', '.join(merged)}"
        elif imp not in lines:
            last = max((i for i, l in enumerate(lines) if IMPORT.match(l)), default=-1)
            lines.insert(last + 1, imp)
    return "\n".join(lines).rstrip("\n") + "\n\n\n" + "\n".join(body).strip("\n") + "\n"
