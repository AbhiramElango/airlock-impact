from pathlib import Path

import pytest

from impact.changes import touched_lines
from impact.coverage_map import CoverageMapper
from impact.parsers.python_ast import PythonParser
from impact.pipeline import ImpactAnalyzer
from impact.runner import PytestRunner
from impact.stores.memory_store import MemoryStore

DEMO = Path(__file__).resolve().parents[1] / "demo"


def test_touched_lines():
    diff = (DEMO / "patches" / "round_tax.diff").read_text()
    assert touched_lines(diff) == {"tax.py": {6}}


@pytest.fixture(scope="module")
def analyzer():
    return ImpactAnalyzer(PythonParser(), lambda _: MemoryStore(), PytestRunner(), CoverageMapper())


def analyze(analyzer, patch):
    return analyzer.analyze(DEMO / "restaurant", (DEMO / "patches" / patch).read_text())


def test_bad_fix_is_a_downstream_regression(analyzer):
    r = analyze(analyzer, "round_tax.diff")
    tests = {t.id: t for t in r.tests}
    assert tests["test_tax.test_add_tax"].scope == "direct"
    assert tests["test_tax.test_add_tax"].status == "passed"
    assert tests["test_receipt.test_total_includes_tax"].scope == "downstream"
    assert tests["test_receipt.test_total_includes_tax"].status == "failed"
    assert r.verdict == "regression"


def test_good_fix_reports_untested_dependents(analyzer):
    r = analyze(analyzer, "good_tax.diff")
    assert not r.regressions
    assert r.gaps == ["receipt.receipt"]
    assert r.verdict == "unvalidated"
