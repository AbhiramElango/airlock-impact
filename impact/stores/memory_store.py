"""In-process store: reverse BFS over dependency edges. Used by tests and when Neo4j is unavailable."""
from __future__ import annotations

from collections import deque

from ..model import DEPENDS_ON, CodeGraph, Impact


class MemoryStore:
    def __init__(self):
        self.graph = CodeGraph()

    def save(self, graph: CodeGraph) -> None:
        self.graph = graph

    def dependents(self, ids: list[str], max_hops: int) -> list[Impact]:
        incoming: dict[str, set[str]] = {}
        for e in self.graph.edges:
            if e.rel in DEPENDS_ON:
                incoming.setdefault(e.dst, set()).add(e.src)

        seen: dict[str, Impact] = {}
        queue = deque((i, (i,)) for i in ids)
        while queue:
            node, path = queue.popleft()
            if len(path) > max_hops:
                continue
            for dep in sorted(incoming.get(node, ())):
                if dep in ids or dep in seen:
                    continue
                full = (dep, *path)
                seen[dep] = Impact(dep, len(full) - 1, full)
                queue.append((dep, full))
        return sorted(seen.values(), key=lambda i: (i.hops, i.id))
