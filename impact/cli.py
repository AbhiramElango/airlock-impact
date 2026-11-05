from __future__ import annotations

import argparse
import json
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


def build_analyzer(store: str, max_hops: int):
    from .coverage_map import CoverageMapper
    from .pipeline import ImpactAnalyzer
    from .runner import PytestRunner
    return ImpactAnalyzer(PythonParser(), lambda repo: make_store(store, repo), PytestRunner(), CoverageMapper(),
                          max_hops=max_hops)


def cmd_analyze(args) -> None:
    from .render_text import render
    report = build_analyzer(args.store, args.max_hops).analyze(Path(args.repo), Path(args.patch).read_text())
    print(json.dumps(report.to_dict(), indent=2) if args.json else render(report))


def cmd_serve(args) -> None:
    import shlex
    import sys
    args.run = args.run or ["python receipt.py", "python invoice.py"]
    from .agent.fixer import Fixer
    from .agent.ollama import OllamaClient
    from .agent.testwriter import TestWriter
    from .web.server import ReviewApp, serve
    llm = OllamaClient(args.model)
    run_cmds = [[sys.executable if a == "python" else a for a in shlex.split(c)] for c in args.run]
    app = ReviewApp(Path(args.repo).resolve(), Path(args.seed).resolve() if args.seed else None,
                    build_analyzer(args.store, args.max_hops), Fixer(llm), TestWriter(llm),
                    run_cmds, args.model, args.store)
    serve(app, args.port)


def main() -> None:
    p = argparse.ArgumentParser(prog="impact")
    sub = p.add_subparsers(required=True)
    idx = sub.add_parser("index", help="parse a repo into the code graph")
    idx.add_argument("repo")
    idx.add_argument("--store", choices=["neo4j", "memory"], default="neo4j")
    idx.set_defaults(func=cmd_index)
    ana = sub.add_parser("analyze", help="blast radius + validation for a proposed patch")
    ana.add_argument("repo")
    ana.add_argument("patch", help="unified diff file")
    ana.add_argument("--store", choices=["neo4j", "memory"], default="neo4j")
    ana.add_argument("--json", action="store_true")
    ana.add_argument("--max-hops", type=int, default=8, help="how far to follow dependents (default 8)")
    ana.set_defaults(func=cmd_analyze)
    srv = sub.add_parser("serve", help="Impact Review web UI")
    srv.add_argument("--repo", default="demo/work/restaurant", help="repo under review (patches are applied here on approve)")
    srv.add_argument("--seed", default="demo/restaurant", help="pristine copy used by Reset; '' to disable")
    srv.add_argument("--run", action="append", help="program(s) the Run button executes (repeatable)")
    srv.add_argument("--model", default="qwen3.5:9b")
    srv.add_argument("--store", choices=["neo4j", "memory"], default="neo4j")
    srv.add_argument("--max-hops", type=int, default=8)
    srv.add_argument("--port", type=int, default=8090)
    srv.set_defaults(func=cmd_serve)
    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
