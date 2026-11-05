import time
from pathlib import Path

from impact.agent.fixer import Fixer
from impact.agent.testwriter import TestWriter
from impact.coverage_map import CoverageMapper
from impact.parsers.python_ast import PythonParser
from impact.pipeline import ImpactAnalyzer
from impact.runner import PytestRunner
from impact.stores.memory_store import MemoryStore
from impact.web.server import ReviewApp

SEED = Path(__file__).resolve().parent / "fixtures" / "restaurant"
FIX = """EXPLANATION: TAX_PERCENT is a percentage.

FILE: tax.py
<<<<<<< SEARCH
    return amount * (1 + TAX_PERCENT)
=======
    return amount * (1 + TAX_PERCENT / 100)
>>>>>>> REPLACE
"""
WRONG_TEST = 'EXPLANATION: checks the receipt.\n\n```python\nfrom receipt import receipt\n\n\ndef test_receipt_total():\n    assert "20.00" in receipt()\n```\n'
RIGHT_TEST = WRONG_TEST.replace("20.00", "19.98")


class ScriptedLLM:
    def __init__(self, *replies):
        self.replies = list(replies)

    def complete(self, prompt: str) -> str:
        return self.replies.pop(0)


def wait(app):
    while app.session.busy:
        time.sleep(0.05)


def test_agent_corrects_its_own_failing_test(tmp_path):
    llm = ScriptedLLM(FIX, WRONG_TEST, RIGHT_TEST)
    analyzer = ImpactAnalyzer(PythonParser(), lambda _: MemoryStore(), PytestRunner(), CoverageMapper())
    app = ReviewApp(tmp_path / "restaurant", SEED, analyzer, Fixer(llm), TestWriter(llm),
                    ["python", "receipt.py"], "fake", "memory")
    app.start("ask", {"request": "receipt total too high"})
    wait(app)
    assert app.session.attempts[-1].report.verdict == "unvalidated"

    app.start("cover", {})
    wait(app)
    assert not app.session.error
    keys = [s.key for s in app.session.steps]
    assert "selfcheck" in keys
    final = app.session.attempts[-1]
    assert final.source == "tests" and final.report.verdict == "validated"
    assert '"19.98" in receipt()' in final.diff


BREAK_SHARED = """EXPLANATION: sales_tax should return only the tax.

FILE: tax.py
<<<<<<< SEARCH
    return amount * (1 + TAX_PERCENT / 100)
=======
    return amount * TAX_PERCENT / 100
>>>>>>> REPLACE
"""
FIX_CALLER = """EXPLANATION: The receipt counted the food twice.

FILE: receipt.py
<<<<<<< SEARCH
    return {"food": food, "total": round(food + sales_tax(food), 2)}
=======
    return {"food": food, "total": round(sales_tax(food), 2)}
>>>>>>> REPLACE
"""
DEMO_SEED = Path(__file__).resolve().parents[1] / "demo" / "restaurant"


def test_graph_locks_shared_code_and_revision_fixes_the_caller(tmp_path):
    # first revision reply violates the lock, the retry fixes the caller
    llm = ScriptedLLM(BREAK_SHARED, BREAK_SHARED, FIX_CALLER)
    analyzer = ImpactAnalyzer(PythonParser(), lambda _: MemoryStore(), PytestRunner(), CoverageMapper())
    app = ReviewApp(tmp_path / "restaurant", DEMO_SEED, analyzer, Fixer(llm), TestWriter(llm),
                    ["python", "receipt.py"], "fake", "memory")
    app.start("ask", {"request": "receipt total too high"})
    wait(app)
    first = app.session.attempts[-1].report
    assert first.verdict == "regression"
    assert "test_invoice.test_invoice_includes_tax_and_delivery" in {t.id for t in first.regressions}

    app.start("revise", {})
    wait(app)
    assert not app.session.error
    final = app.session.attempts[-1]
    assert final.explanation.startswith("Locked invoice.invoice_total, tax.sales_tax:")
    assert "tax.py" not in final.diff and not final.report.regressions
