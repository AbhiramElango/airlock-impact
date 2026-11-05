from pathlib import Path

import pytest

from impact.changes import touched_lines
from impact.coverage_map import CoverageMapper
from impact.parsers.python_ast import PythonParser
from impact.pipeline import ImpactAnalyzer
from impact.runner import PytestRunner
from impact.stores.memory_store import MemoryStore

DEMO = Path(__file__).resolve().parent / "fixtures"


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


GAP_TEST = '''--- a/test_receipt.py
+++ b/test_receipt.py
@@ -1,6 +1,6 @@
 from pytest import approx

-from receipt import totals
+from receipt import receipt, totals


 def test_food_subtotal():
@@ -9,3 +9,7 @@

 def test_total_includes_tax():
     assert totals()["total"] == approx(19.98)
+
+
+def test_receipt_shows_total():
+    assert "19.98" in receipt()
'''


def test_added_test_closes_the_gap(analyzer):
    diff = (DEMO / "patches" / "good_tax.diff").read_text() + GAP_TEST.replace("\n\n", "\n \n")
    r = analyzer.analyze(DEMO / "restaurant", diff)
    added = [t for t in r.tests if "added by patch" in t.why]
    assert [t.id for t in added] == ["test_receipt.test_receipt_shows_total"]
    assert added[0].status == "passed"
    assert [c.id for c in r.changed] == ["tax.add_tax"]  # the test file's import edit is not "code under change"
    assert r.verdict == "validated"


def test_tests_failing_before_are_always_run(analyzer):
    unrelated = (DEMO / "patches" / "good_tax.diff").read_text()
    r = analyzer.analyze(DEMO / "restaurant", unrelated)
    before = {t.id for t in r.tests if "failing before the fix" in t.why}
    assert before == {"test_tax.test_add_tax", "test_receipt.test_total_includes_tax"}
    assert all(t.status == "passed" for t in r.tests if t.id in before)
