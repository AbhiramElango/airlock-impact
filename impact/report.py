"""The single result model. CLI and web UI are just renderers of this."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class SymbolRef:
    id: str
    kind: str
    file: str
    line: int


@dataclass(frozen=True)
class ImpactRef:
    id: str
    kind: str
    hops: int
    path: list[str]
    evidence: list[str]  # test ids that exercise this symbol (static path or runtime coverage)


@dataclass(frozen=True)
class TestRun:
    id: str
    nodeid: str
    scope: str  # direct: exercises the changed code itself | downstream: reaches it through dependents
    why: list[str]  # static | runtime
    status: str
    message: str = ""
    path: list[str] = field(default_factory=list)  # static dependency chain test -> ... -> change


@dataclass
class Report:
    repo: str
    changed: list[SymbolRef]
    impacted: list[ImpactRef]
    tests: list[TestRun]
    gaps: list[str]  # changed/impacted symbols with no test evidence at all
    unresolved: list[str]
    graph: dict = field(default_factory=dict)  # nodes/edges for the UI

    @property
    def regressions(self) -> list[TestRun]:
        return [t for t in self.tests if t.status in ("failed", "error")]

    @property
    def verdict(self) -> str:
        if self.regressions:
            return "regression"
        return "unvalidated" if self.gaps else "validated"

    def to_dict(self) -> dict:
        return {**asdict(self), "verdict": self.verdict}
