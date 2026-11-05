from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

from .parsers.python_ast import PythonParser
from .stores.memory_store import MemoryStore


def make_store(name: str, repo: str):
    if name == "neo4j":
        from .stores.neo4j_store import Neo4jStore
        return Neo4jStore(repo)
    return MemoryStore()


def cmd_index(args) -> None:
    root = Path(args.repo).resolve()
    graph = PythonParser().parse(root)
    make_store(args.store, root.name).save(graph)
    kinds = Counter(str(n.kind) for n in graph.nodes.values())
    rels = Counter(str(e.rel) for e in graph.edges)
    print(f"indexed {root.name} into {args.store}")
    print("  nodes:", dict(kinds))
    print("  edges:", dict(rels))
    print(f"  unresolved calls: {len(graph.unresolved)}")
    for u in graph.unresolved:
        print("   ", u)


def main() -> None:
    p = argparse.ArgumentParser(prog="impact")
    sub = p.add_subparsers(required=True)
    idx = sub.add_parser("index", help="parse a repo into the code graph")
    idx.add_argument("repo")
    idx.add_argument("--store", choices=["neo4j", "memory"], default="neo4j")
    idx.set_defaults(func=cmd_index)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
