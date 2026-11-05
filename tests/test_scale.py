"""Deep, path-heavy graph: 15 layers, each function calls both functions below it (2^15 paths)."""
import time

import pytest

from impact.parsers.python_ast import PythonParser
from impact.stores.memory_store import MemoryStore

LAYERS = 15


@pytest.fixture(scope="module")
def deep_graph(tmp_path_factory):
    root = tmp_path_factory.mktemp("deep")
    (root / "layer0.py").write_text("def a():\n    return 1\n\n\ndef b():\n    return 2\n")
    for i in range(1, LAYERS):
        (root / f"layer{i}.py").write_text(
            f"from layer{i - 1} import a as pa, b as pb\n\n\n"
            "def a():\n    return pa() + pb()\n\n\n"
            "def b():\n    return pa() - pb()\n")
    return PythonParser().parse(root)


def test_memory_store_reaches_every_layer(deep_graph):
    store = MemoryStore()
    store.save(deep_graph)
    found = {i.id: i.hops for i in store.dependents(["layer0.a"], max_hops=LAYERS)}
    assert found[f"layer{LAYERS - 1}.a"] == LAYERS - 1
    assert len(found) == 2 * (LAYERS - 1)  # a and b in every layer above 0


@pytest.mark.neo4j
def test_neo4j_deep_graph_is_fast_and_matches(deep_graph):
    neo4j_store = pytest.importorskip("impact.stores.neo4j_store")
    try:
        store = neo4j_store.Neo4jStore("pytest-deep")
        store.save(deep_graph)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"neo4j unavailable: {e}")
    mem = MemoryStore()
    mem.save(deep_graph)
    try:
        start = time.monotonic()
        got = store.dependents(["layer0.a"], max_hops=LAYERS)
        assert time.monotonic() - start < 5
        assert {(i.id, i.hops) for i in got} == {(i.id, i.hops) for i in mem.dependents(["layer0.a"], LAYERS)}
    finally:
        store.close()
