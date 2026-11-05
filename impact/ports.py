"""Interfaces the pipeline depends on. Adapters implement them; the core never imports an adapter."""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .model import CodeGraph, Impact, TestOutcome


class LanguageParser(Protocol):
    def handles(self, path: Path) -> bool: ...
    def parse(self, root: Path) -> CodeGraph: ...


class GraphStore(Protocol):
    def save(self, graph: CodeGraph) -> None: ...
    def dependents(self, ids: list[str], max_hops: int) -> list[Impact]: ...


class TestRunner(Protocol):
    def run(self, root: Path, nodeids: list[str]) -> dict[str, TestOutcome]: ...


class EvidenceProvider(Protocol):
    """Runtime evidence: which test executed which symbol."""
    def covers(self, root: Path, graph: CodeGraph) -> set[tuple[str, str]]: ...
