"""Orchestration. Every collaborator is injected, so any adapter can be swapped."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

from .changes import changed_symbols
from .coverage_map import CoverageMapper, add_covers
from .model import CodeGraph, Kind, Rel
from .ports import GraphStore, LanguageParser
from .report import ImpactRef, Report, SymbolRef, TestRun
from .runner import PytestRunner, nodeid
from .workspace import apply_patch, scratch_copy

MAX_HOPS = 4


class ImpactAnalyzer:
    def __init__(self, parser: LanguageParser, store_for: Callable[[str], GraphStore],
                 runner: PytestRunner, coverage: CoverageMapper, max_hops: int = MAX_HOPS):
        self.parser, self.store_for = parser, store_for
        self.runner, self.coverage, self.max_hops = runner, coverage, max_hops
        self._covers: dict[Path, set[tuple[str, str]]] = {}

    def baseline_covers(self, repo: Path) -> set[tuple[str, str]]:
        """Which test executes which symbol on the unpatched code. Cached per repo."""
        if repo not in self._covers:
            base = scratch_copy(repo, "base")
            self._covers[repo] = self.coverage.covers(base, self.parser.parse(base))
        return self._covers[repo]

    def analyze(self, repo: Path, diff: str) -> Report:
        repo = repo.resolve()
        covers = self.baseline_covers(repo)

        work = scratch_copy(repo, "patched")
        apply_patch(work, diff)
        graph = self.parser.parse(work)
        add_covers(graph, covers)
        store = self.store_for(repo.name)
        store.save(graph)

        changed = changed_symbols(diff, graph)
        changed_ids = [n.id for n in changed]
        impacted = store.dependents(changed_ids, self.max_hops)

        tests = self._select_tests(graph, changed_ids, impacted, covers)
        outcomes = self.runner.run(work, [tests[t]["nodeid"] for t in tests])
        runs = [TestRun(t, info["nodeid"], info["scope"], sorted(info["why"]),
                        outcomes.get(t).status if t in outcomes else "not_run",
                        outcomes.get(t).message if t in outcomes else "")
                for t, info in sorted(tests.items(), key=lambda kv: (kv[1]["scope"] != "direct", kv[0]))]

        evidence = self._evidence(graph, impacted, covers)
        impacted_refs = [ImpactRef(i.id, str(graph.nodes[i.id].kind), i.hops, list(i.path), evidence.get(i.id, []))
                         for i in impacted if graph.nodes[i.id].kind != Kind.TEST]
        symbols = changed_ids + [i.id for i in impacted_refs]
        gaps = [s for s in symbols if not evidence.get(s) and graph.nodes[s].kind == Kind.FUNCTION]

        return Report(
            repo=repo.name,
            changed=[SymbolRef(n.id, str(n.kind), n.file, n.start) for n in changed],
            impacted=impacted_refs,
            tests=runs,
            gaps=gaps,
            unresolved=graph.unresolved,
            graph=self._ui_graph(graph),
        )

    def _select_tests(self, graph: CodeGraph, changed: list[str], impacted, covers) -> dict[str, dict]:
        """Static: tests among the dependents. Runtime: tests observed executing changed/impacted code."""
        targets = set(changed) | {i.id for i in impacted}
        selected: dict[str, dict] = {}

        def add(test_id: str, why: str, direct: bool) -> None:
            node = graph.nodes[test_id]
            entry = selected.setdefault(test_id, {"nodeid": nodeid(node.file, node.name), "why": set(),
                                                  "scope": "downstream"})
            entry["why"].add(why)
            if direct:
                entry["scope"] = "direct"

        for i in impacted:
            if graph.nodes[i.id].kind == Kind.TEST:
                add(i.id, "static", direct=i.hops == 1)
        for test_id, symbol in covers:
            if symbol in targets and test_id in graph.nodes:
                add(test_id, "runtime", direct=_is_unit_test(test_id, changed, covers))
        return selected

    @staticmethod
    def _evidence(graph: CodeGraph, impacted, covers) -> dict[str, list[str]]:
        """Symbol -> tests that exercise it, by runtime coverage or by a static path from the test."""
        ev: dict[str, set[str]] = {}
        for test_id, symbol in covers:
            ev.setdefault(symbol, set()).add(test_id)
        for i in impacted:
            if graph.nodes[i.id].kind == Kind.TEST:
                for symbol in i.path[1:]:
                    ev.setdefault(symbol, set()).add(i.id)
        return {k: sorted(v) for k, v in ev.items()}

    @staticmethod
    def _ui_graph(graph: CodeGraph) -> dict:
        return {"nodes": [{**asdict(n), "kind": str(n.kind)} for n in graph.nodes.values() if n.kind != Kind.FILE],
                "edges": [{"src": e.src, "dst": e.dst, "rel": str(e.rel), "source": e.source}
                          for e in graph.edges if e.rel in (Rel.CALLS, Rel.READS, Rel.COVERS)]}


def _is_unit_test(test_id: str, changed: list[str], covers) -> bool:
    """Direct (unit) test: executes the changed code and nothing else from the repo."""
    touched = {s for t, s in covers if t == test_id}
    return bool(touched & set(changed)) and len(touched - set(changed)) == 0
