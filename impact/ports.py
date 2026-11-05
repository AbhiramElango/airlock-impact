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


class LLM(Protocol):
    def complete(self, prompt: str) -> str: ...


class Progress(Protocol):
    """Observer for pipeline steps, so a UI can show work as it happens."""
    def start(self, key: str, label: str) -> None: ...
    def done(self, key: str, detail: str = "", ok: bool = True) -> None: ...


class NoProgress:
    def start(self, key: str, label: str) -> None:
        pass

    def done(self, key: str, detail: str = "", ok: bool = True) -> None:
        pass
