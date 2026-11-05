"""Interfaces the pipeline depends on. Adapters implement them; the core never imports an adapter."""
from __future__ import annotations

from pathlib import Path
from typing import Protocol

from .model import CodeGraph, Impact


class LanguageParser(Protocol):
    def handles(self, path: Path) -> bool: ...
    def parse(self, root: Path) -> CodeGraph: ...


class GraphStore(Protocol):
    def save(self, graph: CodeGraph) -> None: ...
    def dependents(self, ids: list[str], max_hops: int) -> list[Impact]: ...
