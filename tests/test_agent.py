from pathlib import Path

import pytest

from impact.agent import edits
from impact.agent.fixer import Fixer
from impact.agent.ollama import require_loopback

DEMO = Path(__file__).resolve().parent / "fixtures" / "restaurant"

REPLY = """EXPLANATION: TAX_PERCENT is a percentage, so divide by 100.

FILE: tax.py
<<<<<<< SEARCH
    return amount * (1 + TAX_PERCENT)
=======
    return amount * (1 + TAX_PERCENT / 100)
>>>>>>> REPLACE
"""


class FakeLLM:
    def __init__(self, reply: str):
        self.reply, self.prompts = reply, []

    def complete(self, prompt: str) -> str:
        self.prompts.append(prompt)
        return self.reply


def test_reply_becomes_valid_diff():
    proposal = Fixer(FakeLLM(REPLY)).propose(DEMO, "receipt too high")
    assert proposal.explanation.startswith("TAX_PERCENT is a percentage")
    assert "+    return amount * (1 + TAX_PERCENT / 100)" in proposal.diff
    assert proposal.diff.startswith("--- a/tax.py\n+++ b/tax.py\n")


def test_search_must_match():
    bad = REPLY.replace("return amount * (1 + TAX_PERCENT)\n=", "return nothing\n=")
    with pytest.raises(edits.EditError):
        Fixer(FakeLLM(bad)).propose(DEMO, "x")


def test_no_edits_is_an_error():
    with pytest.raises(edits.EditError):
        edits.parse("I think the bug is in tax.py")


def test_paths_cannot_escape_repo():
    with pytest.raises(edits.EditError):
        edits.to_diff(DEMO, [edits.Edit("../../etc/passwd", "a", "b")])


def test_llm_must_be_local():
    require_loopback("http://127.0.0.1:11434")
    with pytest.raises(ValueError):
        require_loopback("https://api.example.com")


def test_tolerates_decorated_file_header():
    _, found = edits.parse(REPLY.replace("FILE: tax.py", "FILE: --- tax.py ---"))
    assert found[0].file == "tax.py"


def test_merge_places_imports_and_appends_tests():
    from impact.agent.testwriter import _merge
    existing = "from pytest import approx\n\nfrom receipt import totals\n\n\ndef test_a():\n    pass\n"
    new = "\nfrom pytest import approx\nfrom receipt import receipt\n\n\ndef test_b():\n    assert receipt()\n"
    out = _merge(existing, new)
    assert "from receipt import totals, receipt" in out
    assert out.count("from pytest import approx") == 1
    assert out.rstrip().endswith("def test_b():\n    assert receipt()")


def test_accepts_diff_style_path_prefix():
    diff = edits.to_diff(DEMO, [edits.Edit("a/tax.py", "return amount * (1 + TAX_PERCENT)",
                                           "return amount * (1 + TAX_PERCENT / 100)")])
    assert diff.startswith("--- a/tax.py")
