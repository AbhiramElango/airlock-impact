"""Python adapter: builds the code graph from source with the stdlib `ast` module (static only)."""
from __future__ import annotations

import ast
import builtins
from dataclasses import dataclass, field
from pathlib import Path

from ..model import CodeGraph, Kind, Node, Rel

IGNORED_DIRS = {".git", ".venv", "venv", "__pycache__", "node_modules", ".pytest_cache"}
BUILTINS = frozenset(dir(builtins))


def is_test_file(path: Path) -> bool:
    return path.name.startswith("test_") or path.stem.endswith("_test")


def module_name(rel: Path) -> str:
    parts = list(rel.with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


@dataclass
class Module:
    name: str
    file: str
    tree: ast.Module
    symbols: dict[str, str] = field(default_factory=dict)  # local name -> node id
    modules: dict[str, str] = field(default_factory=dict)  # alias -> module name
    external: set[str] = field(default_factory=set)  # names imported from outside the repo
    bodies: dict[str, ast.AST] = field(default_factory=dict)  # function id -> its ast node


class PythonParser:
    def handles(self, path: Path) -> bool:
        return path.suffix == ".py"

    def parse(self, root: Path) -> CodeGraph:
        graph = CodeGraph()
        mods = [self._define(graph, root, p) for p in self._files(root)]
        by_name = {m.name: m for m in mods}
        for m in mods:
            self._resolve_imports(graph, m, by_name)
        for m in mods:
            self._link_bodies(graph, m, by_name)
        return graph

    def _files(self, root: Path) -> list[Path]:
        return sorted(p for p in root.rglob("*.py")
                      if not IGNORED_DIRS.intersection(p.relative_to(root).parts))

    # pass 1: definitions
    def _define(self, graph: CodeGraph, root: Path, path: Path) -> Module:
        rel = path.relative_to(root)
        file = rel.as_posix()
        tree = ast.parse(path.read_text(), filename=file)
        mod = Module(module_name(rel), file, tree)
        graph.add(Node(f"file:{file}", Kind.FILE, file, file, 1, len(tree.body) and tree.body[-1].end_lineno))
        test_file = is_test_file(path)

        for stmt in tree.body:
            if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
                kind = Kind.TEST if test_file and stmt.name.startswith("test") else Kind.FUNCTION
                self._symbol(graph, mod, stmt.name, kind, stmt, f"file:{file}")
            elif isinstance(stmt, ast.ClassDef):
                cid = self._symbol(graph, mod, stmt.name, Kind.CLASS, stmt, f"file:{file}")
                for item in stmt.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        kind = Kind.TEST if test_file and item.name.startswith("test") else Kind.FUNCTION
                        self._symbol(graph, mod, f"{stmt.name}.{item.name}", kind, item, cid)
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                for t in targets:
                    if isinstance(t, ast.Name):
                        self._symbol(graph, mod, t.id, Kind.VARIABLE, stmt, f"file:{file}")
        return mod

    def _symbol(self, graph: CodeGraph, mod: Module, qual: str, kind: Kind, node: ast.AST, parent: str) -> str:
        nid = f"{mod.name}.{qual}"
        graph.add(Node(nid, kind, qual, mod.file, node.lineno, node.end_lineno))
        graph.link(parent, nid, Rel.DEFINES)
        mod.symbols[qual] = nid
        if kind in (Kind.FUNCTION, Kind.TEST):
            mod.bodies[nid] = node
        return nid

    # pass 2: imports
    def _resolve_imports(self, graph: CodeGraph, mod: Module, by_name: dict[str, Module]) -> None:
        for stmt in ast.walk(mod.tree):
            if isinstance(stmt, ast.Import):
                for a in stmt.names:
                    local = a.asname or a.name.split(".")[0]
                    if a.name in by_name:
                        mod.modules[local] = a.name
                        graph.link(f"file:{mod.file}", f"file:{by_name[a.name].file}", Rel.IMPORTS)
                    else:
                        mod.external.add(local)
            elif isinstance(stmt, ast.ImportFrom) and stmt.module:
                target = self._absolute(mod.name, stmt.module, stmt.level)
                src = by_name.get(target)
                if not src:
                    mod.external.update(a.asname or a.name for a in stmt.names)
                    continue
                graph.link(f"file:{mod.file}", f"file:{src.file}", Rel.IMPORTS)
                for a in stmt.names:
                    local = a.asname or a.name
                    if f"{target}.{a.name}" in by_name:
                        mod.modules[local] = f"{target}.{a.name}"
                    elif a.name in src.symbols:
                        mod.symbols[local] = src.symbols[a.name]

    @staticmethod
    def _absolute(current: str, module: str, level: int) -> str:
        if not level:
            return module
        base = current.split(".")[:-level]
        return ".".join([*base, module])

    # pass 3: calls and reads inside function bodies
    def _link_bodies(self, graph: CodeGraph, mod: Module, by_name: dict[str, Module]) -> None:
        for nid, fn in mod.bodies.items():
            qual = graph.nodes[nid].name
            cls = qual.split(".")[0] if "." in qual else None
            for sub in ast.walk(fn):
                if isinstance(sub, ast.Call):
                    target = self._callee(sub.func, mod, by_name, cls)
                    if target:
                        graph.link(nid, target, Rel.CALLS)
                    elif self._worth_reporting(sub.func, mod):
                        graph.unresolved.append(f"{nid} -> {ast.unparse(sub.func)}")
                elif isinstance(sub, ast.Name) and isinstance(sub.ctx, ast.Load):
                    target = mod.symbols.get(sub.id)
                    if target and graph.nodes[target].kind == Kind.VARIABLE:
                        graph.link(nid, target, Rel.READS)
                elif isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
                    target = self._module_attr(sub, mod, by_name)
                    if target and graph.nodes[target].kind == Kind.VARIABLE:
                        graph.link(nid, target, Rel.READS)

    @staticmethod
    def _worth_reporting(func: ast.expr, mod: Module) -> bool:
        """Skip builtins, external libraries and literal methods; keep calls that may hide a dependency."""
        known = BUILTINS | mod.external
        if isinstance(func, ast.Name):
            return func.id not in known
        return isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name) and func.value.id not in known

    def _callee(self, func: ast.expr, mod: Module, by_name: dict[str, Module], cls: str | None) -> str | None:
        if isinstance(func, ast.Name):
            return mod.symbols.get(func.id)
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id == "self" and cls:
                return mod.symbols.get(f"{cls}.{func.attr}")
            return self._module_attr(func, mod, by_name)
        return None

    @staticmethod
    def _module_attr(attr: ast.Attribute, mod: Module, by_name: dict[str, Module]) -> str | None:
        target = by_name.get(mod.modules.get(attr.value.id, ""))
        return target.symbols.get(attr.attr) if target else None
