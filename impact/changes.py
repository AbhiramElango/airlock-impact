"""Unified diff -> touched lines -> enclosing symbols."""
from __future__ import annotations

import re
from collections import defaultdict

from .model import CodeGraph, Node

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def touched_lines(diff: str) -> dict[str, set[int]]:
    """New-side line numbers per file. A pure deletion marks the line where it happened."""
    lines: dict[str, set[int]] = defaultdict(set)
    file, new_line = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            path = raw[4:].strip()
            file = None if path == "/dev/null" else path.removeprefix("b/")
        elif raw.startswith("--- "):
            continue
        elif m := HUNK.match(raw):
            new_line = int(m.group(1))
        elif file is None:
            continue
        elif raw.startswith("+"):
            lines[file].add(new_line)
            new_line += 1
        elif raw.startswith("-"):
            lines[file].add(new_line)
        else:
            new_line += 1
    return dict(lines)


def changed_symbols(diff: str, graph: CodeGraph) -> list[Node]:
    """Innermost symbol per touched line; the file node when a line is outside any symbol."""
    found: dict[str, Node] = {}
    for file, lines in touched_lines(diff).items():
        for line in lines:
            node = graph.symbol_at(file, line) or graph.nodes.get(f"file:{file}")
            if node:
                found[node.id] = node
    return sorted(found.values(), key=lambda n: n.id)
