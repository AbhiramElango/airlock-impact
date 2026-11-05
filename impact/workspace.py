"""Disposable copies of the repo. The user's checkout is never modified."""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

IGNORE = shutil.ignore_patterns(".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".coverage*")


class PatchError(RuntimeError):
    pass


def scratch_copy(repo: Path, label: str) -> Path:
    dest = Path(tempfile.mkdtemp(prefix=f"impact-{label}-")) / repo.name
    shutil.copytree(repo, dest, ignore=IGNORE)
    return dest


def apply_patch(root: Path, diff: str) -> None:
    p = subprocess.run(["git", "apply", "--whitespace=nowarn", "-"], cwd=root, input=diff,
                       capture_output=True, text=True)
    if p.returncode:
        raise PatchError(p.stderr.strip() or "git apply failed")
