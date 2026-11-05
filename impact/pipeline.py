"""Orchestration. Every collaborator is injected, so any adapter can be swapped."""
from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import asdict
from pathlib import Path

from .changes import changed_symbols
from .coverage_map import add_covers
from .model import CodeGraph, Kind, Rel
from .ports import EvidenceProvider, GraphStore, LanguageParser, NoProgress, Progress, TestRunner
from .report import ImpactRef, Report, SymbolRef, TestRun
from .runner import nodeid
from .workspace import apply_patch, scratch_copy

MAX_HOPS = 8
UI_FULL_GRAPH_LIMIT = 80


class ImpactAnalyzer:
    def __init__(self, parser: LanguageParser, store_for: Callable[[str], GraphStore],
                 runner: TestRunner, coverage: EvidenceProvider, max_hops: int = MAX_HOPS):
        self.parser, self.store_for = parser, store_for
        self.runner, self.coverage, self.max_hops = runner, coverage, max_hops
        self._covers: dict[str, set[tuple[str, str]]] = {}
        self._failing: dict[str, set[str]] = {}  # tests failing on the unpatched code: the reported bug

    def baseline_covers(self, repo: Path, progress: Progress) -> set[tuple[str, str]]:
        """Which test executes which symbol on the unpatched code. Cached per repo."""
        progress.start("baseline", "Learn what the existing tests exercise")
        key = _fingerprint(repo)
        cached = key in self._covers
        if not cached:
            base = scratch_copy(repo, "base")
            graph = self.parser.parse(base)
            self._covers[key] = self.coverage.covers(base, graph)
            outcomes = self.runner.run(base, [nodeid(n.file, n.name) for n in graph.of_kind(Kind.TEST)])
            self._failing[key] = {t for t, o in outcomes.items() if o.status in ("failed", "error")}
        pairs = self._covers[key]
        progress.done("baseline", f"{len(pairs)} test→function links observed, "
                                  f"{len(self._failing[key])} tests failing before the fix" + (" (cached)" if cached else ""))
        return pairs

    def failing_before(self, repo: Path) -> set[str]:
        return self._failing.get(_fingerprint(repo.resolve()), set())

    def analyze(self, repo: Path, diff: str, progress: Progress = NoProgress()) -> Report:
        repo = repo.resolve()
        covers = self.baseline_covers(repo, progress)

        progress.start("graph", "Apply patch in a sandbox and index the code graph")
        work = scratch_copy(repo, "patched")
        apply_patch(work, diff)
        graph = self.parser.parse(work)
        add_covers(graph, covers)
        store = self.store_for(repo.name)
        store.save(graph)
        progress.done("graph", f"{len(graph.nodes)} nodes · {len(graph.edges)} edges → {type(store).__name__}")

        progress.start("changes", "Map the diff to changed symbols")
        touched = changed_symbols(diff, graph)
        test_files = {n.file for n in graph.of_kind(Kind.TEST)} - {n.file for n in graph.of_kind(Kind.FUNCTION)}
        changed = [n for n in touched  # code under change; edits inside test-only files are evidence
                   if n.kind != Kind.TEST and not (n.kind == Kind.FILE and n.file in test_files)]
        added_tests = [n.id for n in touched if n.kind == Kind.TEST]  # evidence, not change
        changed_ids = [n.id for n in changed]
        progress.done("changes", ", ".join(changed_ids + [f"+{t}" for t in added_tests]) or "no symbols")

        progress.start("blast", "Walk dependents backwards (blast radius)")
        impacted = store.dependents(changed_ids, self.max_hops)
        code = [i for i in impacted if graph.nodes[i.id].kind != Kind.TEST]
        progress.done("blast", f"{len(code)} dependent symbols, up to {max((i.hops for i in code), default=0)} hops")

        tests = self._select_tests(graph, changed_ids, impacted, covers, added_tests, self.failing_before(repo))
        progress.start("tests", f"Run {len(tests)} selected tests in the sandbox")
        outcomes = self.runner.run(work, [tests[t]["nodeid"] for t in tests])
        paths = {i.id: list(i.path) for i in impacted}
        runs = [TestRun(t, info["nodeid"], info["scope"], sorted(info["why"]),
                        outcomes[t].status if t in outcomes else "not_run",
                        outcomes[t].message if t in outcomes else "", paths.get(t, []))
                for t, info in sorted(tests.items(), key=lambda kv: (kv[1]["scope"] != "direct", kv[0]))]
        failed = sum(r.status in ("failed", "error") for r in runs)
        progress.done("tests", f"{len(runs) - failed} passed · {failed} failed", ok=not failed)

        evidence = self._evidence(graph, impacted, covers)
        impacted_refs = [ImpactRef(i.id, str(graph.nodes[i.id].kind), i.hops, list(i.path), evidence.get(i.id, []))
                         for i in code]
        symbols = changed_ids + [i.id for i in impacted_refs]
        gaps = [s for s in symbols if not evidence.get(s) and graph.nodes[s].kind == Kind.FUNCTION]

        return Report(
            repo=repo.name,
            changed=[SymbolRef(n.id, str(n.kind), n.file, n.start) for n in changed],
            impacted=impacted_refs,
            tests=runs,
            gaps=gaps,
            unresolved=graph.unresolved,
            graph=self._ui_graph(graph, set(symbols) | set(tests)),
            evidence={s: evidence.get(s, []) for s in symbols},
        )

    def _select_tests(self, graph: CodeGraph, changed: list[str], impacted, covers,
                      added: list[str], failing_before: set[str]) -> dict[str, dict]:
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
        for test_id in added:
            add(test_id, "added by patch", direct=False)
        for test_id in failing_before:  # the reported bug must be fixed, whatever the patch touched
            if test_id in graph.nodes:
                add(test_id, "failing before the fix", direct=False)
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
    def _ui_graph(graph: CodeGraph, relevant: set[str]) -> dict:
        """Small repos: everything (unaffected code shown faded). Large repos: only the affected subgraph."""
        symbols = [n for n in graph.nodes.values() if n.kind != Kind.FILE]
        keep = {n.id for n in symbols} if len(symbols) <= UI_FULL_GRAPH_LIMIT else relevant
        return {"nodes": [{**asdict(n), "kind": str(n.kind)} for n in symbols if n.id in keep],
                "edges": [{"src": e.src, "dst": e.dst, "rel": str(e.rel), "source": e.source}
                          for e in graph.edges
                          if e.rel in (Rel.CALLS, Rel.READS) and e.src in keep and e.dst in keep]}


def _is_unit_test(test_id: str, changed: list[str], covers) -> bool:
    """Direct (unit) test: executes the changed code and nothing else from the repo."""
    touched = {s for t, s in covers if t == test_id}
    return bool(touched & set(changed)) and len(touched - set(changed)) == 0


def _fingerprint(repo: Path) -> str:
    """Content hash of the repo's source, so cached evidence is never reused after the code changes."""
    h = hashlib.sha256(str(repo).encode())
    for p in sorted(repo.rglob("*.py")):
        if "__pycache__" not in p.parts:
            h.update(p.as_posix().encode())
            h.update(p.read_bytes())
    return h.hexdigest()
