"""SEARCH/REPLACE edits from the model -> unified diff we generate ourselves."""
from __future__ import annotations

import difflib
import re
from dataclasses import dataclass
from pathlib import Path

BLOCK = re.compile(
    r"FILE:[ \t]*(?:-+[ \t]*)?`?(?P<file>[^\s`]+?)`?(?:[ \t]*-+)?[ \t]*\n<<<<<<< SEARCH\n(?P<search>.*?)\n?=======\n(?P<replace>.*?)\n?>>>>>>> REPLACE",
    re.S)
EXPLANATION = re.compile(r"EXPLANATION:\s*(.+?)(?:\n\s*\n|\nFILE:|\Z)", re.S)


class EditError(ValueError):
    pass


@dataclass(frozen=True)
class Edit:
    file: str
    search: str
    replace: str


def parse(text: str) -> tuple[str, list[Edit]]:
    m = EXPLANATION.search(text)
    explanation = m.group(1).strip() if m else ""
    edits = [Edit(b["file"].strip("`"), b["search"], b["replace"]) for b in BLOCK.finditer(text)]
    if not edits:
        raise EditError("model returned no SEARCH/REPLACE edits")
    return explanation, edits


def to_diff(root: Path, edits: list[Edit]) -> str:
    """Apply edits in memory and return a unified diff. The repo on disk is not modified."""
    new: dict[str, str] = {}
    for e in edits:
        path = (root / e.file).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise EditError(f"unknown file: {e.file}")
        text = new.get(e.file, path.read_text())
        if text.count(e.search) != 1:
            stripped = _match_ignoring_trailing_space(text, e.search)
            if stripped is None:
                raise EditError(f"SEARCH text not found exactly once in {e.file}")
            e = Edit(e.file, stripped, e.replace)
        new[e.file] = text.replace(e.search, e.replace, 1)

    return unified({f: ((root / f).read_text(), after) for f, after in new.items()})


def unified(changes: dict[str, tuple[str, str]]) -> str:
    """{file: (before, after)} -> one unified diff that `git apply` accepts."""
    chunks = []
    for file, (before, after) in changes.items():
        chunks.extend(difflib.unified_diff(before.splitlines(keepends=True), after.splitlines(keepends=True),
                                           f"a/{file}", f"b/{file}"))
    diff = "".join(chunks)
    if not diff:
        raise EditError("edits change nothing")
    return diff if diff.endswith("\n") else diff + "\n"


def _match_ignoring_trailing_space(text: str, search: str) -> str | None:
    want = [l.rstrip() for l in search.splitlines()]
    lines = text.splitlines(keepends=True)
    hits = [i for i in range(len(lines) - len(want) + 1)
            if [l.rstrip() for l in lines[i:i + len(want)]] == want]
    return "".join(lines[hits[0]:hits[0] + len(want)]).rstrip("\n") if len(hits) == 1 else None
