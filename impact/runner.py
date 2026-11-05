"""Runs pytest in a subprocess: no shell, scrubbed env, timeout, results from JUnit XML."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from .model import TestOutcome

ENV_KEEP = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")


def scrubbed_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in ENV_KEEP if k in os.environ}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def nodeid(file: str, qual: str) -> str:
    return "::".join([file, *qual.split(".")])


class PytestRunner:
    def __init__(self, python: str = sys.executable, timeout_s: int = 120):
        self.python, self.timeout_s = python, timeout_s

    def command(self, junit: Path, nodeids: list[str]) -> list[str]:
        return [self.python, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={junit}", *nodeids]

    def run(self, root: Path, nodeids: list[str]) -> dict[str, TestOutcome]:
        """Keyed by dotted test id (module.Class.test), matching graph node ids."""
        if not nodeids:
            return {}
        with tempfile.TemporaryDirectory() as tmp:
            junit = Path(tmp) / "junit.xml"
            try:
                subprocess.run(self.command(junit, nodeids), cwd=root, env=scrubbed_env(),
                               capture_output=True, text=True, timeout=self.timeout_s, stdin=subprocess.DEVNULL)
            except subprocess.TimeoutExpired:
                return {n: TestOutcome("error", f"timed out after {self.timeout_s}s") for n in nodeids}
            return parse_junit(junit) if junit.exists() else {}


def parse_junit(path: Path) -> dict[str, TestOutcome]:
    results = {}
    for case in ET.parse(path).iter("testcase"):
        test_id = f"{case.get('classname')}.{case.get('name')}"
        status, message = "passed", ""
        for tag in ("failure", "error", "skipped"):
            el = case.find(tag)
            if el is not None:
                status = "failed" if tag == "failure" else tag
                message = (el.get("message") or el.text or "").strip()[:500]
                break
        results[test_id] = TestOutcome(status, message)
    return results
