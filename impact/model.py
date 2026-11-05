"""Language-neutral code graph. Every adapter produces and consumes these types."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class Kind(StrEnum):
    FILE = "File"
    FUNCTION = "Function"
    CLASS = "Class"
    VARIABLE = "Variable"
    TEST = "Test"


class Rel(StrEnum):
    DEFINES = "DEFINES"
    CALLS = "CALLS"
    READS = "READS"
    IMPORTS = "IMPORTS"
    COVERS = "COVERS"  # test -> symbol, observed at runtime


DEPENDS_ON = (Rel.CALLS, Rel.READS)  # edges along which a change propagates to dependents


@dataclass(frozen=True)
class Node:
    id: str  # stable, repo-scoped: "tax.add_tax", "file:tax.py"
    kind: Kind
    name: str
    file: str
    start: int = 0
    end: int = 0


@dataclass(frozen=True)
class Edge:
    src: str
    dst: str
    rel: Rel
    source: str = "static"  # provenance: static | runtime


@dataclass
class CodeGraph:
    nodes: dict[str, Node] = field(default_factory=dict)
    edges: set[Edge] = field(default_factory=set)
    unresolved: list[str] = field(default_factory=list)  # calls we could not resolve statically

    def add(self, node: Node) -> None:
        self.nodes[node.id] = node

    def link(self, src: str, dst: str, rel: Rel, source: str = "static") -> None:
        if src != dst:
            self.edges.add(Edge(src, dst, rel, source))

    def of_kind(self, *kinds: Kind) -> list[Node]:
        return [n for n in self.nodes.values() if n.kind in kinds]

    def symbol_at(self, file: str, line: int) -> Node | None:
        """Innermost function/class/variable whose span contains the line."""
        hits = [n for n in self.nodes.values()
                if n.file == file and n.kind != Kind.FILE and n.start <= line <= n.end]
        return min(hits, key=lambda n: n.end - n.start, default=None)


@dataclass(frozen=True)
class Impact:
    id: str
    hops: int
    path: tuple[str, ...]  # dependent -> ... -> changed symbol
