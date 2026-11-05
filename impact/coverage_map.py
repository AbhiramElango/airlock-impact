"""Runtime evidence: run the suite once under coverage.py with per-test contexts -> COVERS edges."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from .model import CodeGraph, Kind, Rel
from .runner import scrubbed_env

RCFILE = """[run]
data_file = {data}
dynamic_context = test_function
relative_files = true
source = .
"""


class CoverageMapper:
    def __init__(self, python: str = sys.executable, timeout_s: int = 300):
        self.python, self.timeout_s = python, timeout_s

    def covers(self, root: Path, graph: CodeGraph) -> set[tuple[str, str]]:
        """(test_id, symbol_id) pairs observed while running the full suite in `root`."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            rc = tmp / "coveragerc"
            rc.write_text(RCFILE.format(data=tmp / ".coverage"))
            out = tmp / "cov.json"
            run = dict(cwd=root, env=scrubbed_env(), capture_output=True, text=True, timeout=self.timeout_s)
            subprocess.run([self.python, "-m", "coverage", "run", f"--rcfile={rc}",
                            "-m", "pytest", "-q", "-p", "no:cacheprovider"], **run)
            subprocess.run([self.python, "-m", "coverage", "json", f"--rcfile={rc}",
                            "--show-contexts", "-o", str(out)], **run)
            if not out.exists():
                return set()
            data = json.loads(out.read_text())

        tests = {n.id for n in graph.of_kind(Kind.TEST)}
        pairs = set()
        for file, info in data.get("files", {}).items():
            for line, contexts in info.get("contexts", {}).items():
                symbol = graph.symbol_at(file, int(line))
                if not symbol or symbol.kind == Kind.TEST:
                    continue
                for ctx in contexts:
                    test_id = ctx.split("|")[0]  # "module.test_name|run"
                    if test_id in tests:
                        pairs.add((test_id, symbol.id))
        return pairs


def add_covers(graph: CodeGraph, pairs: set[tuple[str, str]]) -> None:
    for test_id, symbol_id in pairs:
        if test_id in graph.nodes and symbol_id in graph.nodes:
            graph.link(test_id, symbol_id, Rel.COVERS, source="runtime")
