from pathlib import Path

import pytest

from impact.model import Kind, Rel
from impact.parsers.python_ast import PythonParser
from impact.stores.memory_store import MemoryStore

DEMO = Path(__file__).resolve().parents[1] / "demo" / "restaurant"


@pytest.fixture(scope="module")
def graph():
    return PythonParser().parse(DEMO)


def edges(graph, rel):
    return {(e.src, e.dst) for e in graph.edges if e.rel == rel}


def test_kinds(graph):
    assert graph.nodes["tax.add_tax"].kind == Kind.FUNCTION
    assert graph.nodes["test_tax.test_add_tax"].kind == Kind.TEST
    assert graph.nodes["settings.TAX_PERCENT"].kind == Kind.VARIABLE


def test_cross_file_calls_and_reads(graph):
    assert ("receipt.totals", "tax.add_tax") in edges(graph, Rel.CALLS)
    assert ("bill.split", "bill.total_with_tip") in edges(graph, Rel.CALLS)
    assert ("tax.add_tax", "settings.TAX_PERCENT") in edges(graph, Rel.READS)
    assert ("receipt.totals", "receipt.ORDER") in edges(graph, Rel.READS)  # default argument


def test_external_calls_not_unresolved(graph):
    assert graph.unresolved == []


def test_symbol_at_line(graph):
    assert graph.symbol_at("tax.py", 6).id == "tax.add_tax"


def test_dependents_multi_hop(graph):
    store = MemoryStore()
    store.save(graph)
    found = {i.id: i for i in store.dependents(["settings.TAX_PERCENT"], max_hops=4)}
    assert found["receipt.receipt"].path == (
        "receipt.receipt", "receipt.totals", "tax.add_tax", "settings.TAX_PERCENT")
    assert "test_receipt.test_total_includes_tax" in found
    assert "bill.split" not in found


def test_hop_limit(graph):
    store = MemoryStore()
    store.save(graph)
    assert {i.id for i in store.dependents(["settings.TAX_PERCENT"], max_hops=1)} == {"tax.add_tax"}


@pytest.mark.neo4j
def test_neo4j_matches_memory(graph):
    neo4j_store = pytest.importorskip("impact.stores.neo4j_store")
    try:
        store = neo4j_store.Neo4jStore("pytest-restaurant")
        store.save(graph)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"neo4j unavailable: {e}")
    mem = MemoryStore()
    mem.save(graph)
    try:
        assert store.dependents(["tax.add_tax"], 4) == mem.dependents(["tax.add_tax"], 4)
    finally:
        store.close()
