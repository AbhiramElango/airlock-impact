"""Terminal renderer for a Report."""
from __future__ import annotations

from .report import Report

ICON = {"passed": "✅", "failed": "❌", "error": "❌", "skipped": "⏭ ", "not_run": "·"}
VERDICT = {"regression": "❌ REGRESSION — do not approve",
           "unvalidated": "⚠️  PASSES, BUT PARTS ARE UNTESTED",
           "validated": "✅ VALIDATED — every affected function has passing test evidence"}


def short(symbol_id: str) -> str:
    return symbol_id.split(".", 1)[-1] if "." in symbol_id else symbol_id


def render(r: Report) -> str:
    out = [f"Impact report · {r.repo}", ""]
    out.append("Changed")
    out += [f"  • {c.id}  ({c.file}:{c.line})" for c in r.changed]

    out += ["", f"Blast radius ({len(r.impacted)} dependents)"]
    for i in r.impacted:
        out.append(f"  {i.hops} hop{'s' if i.hops > 1 else ' '}  {' → '.join(i.path)}")

    out += ["", "Tests"]
    for t in r.tests:
        line = f"  {ICON.get(t.status, '?')} {t.id:<40} {t.scope:<10} via {'+'.join(t.why)}"
        out.append(line)
        if t.message and t.status in ("failed", "error"):
            out.append(f"       {t.message.splitlines()[0][:100]}")

    if r.gaps:
        out += ["", "No test evidence"]
        out += [f"  ⚠️  {g}" for g in r.gaps]
    if r.unresolved:
        out += ["", f"Unresolved calls ({len(r.unresolved)}) — dependencies we could not see statically"]
        out += [f"  ? {u}" for u in r.unresolved[:10]]

    direct = [t for t in r.tests if t.scope == "direct"]
    if direct and all(t.status == "passed" for t in direct) and r.regressions:
        out += ["", "The change's own tests pass. A downstream test fails."]
    out += ["", VERDICT[r.verdict]]
    return "\n".join(out)
