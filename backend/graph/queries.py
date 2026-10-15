"""Loads the named Cypher queries from the repository's queries/ folder.

Format of a .cypher file:

    // name: shared_infrastructure
    // Accounts that log in from the same device or IP as $id.
    MATCH ...

Each `// name:` line starts a new query; the comment lines under it are its
description. Code refers to queries only by name, so queries/ is the single,
judge-readable source of truth for every graph operation the product performs.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.config import settings

_NAME = re.compile(r"^//\s*name:\s*([a-z0-9_]+)\s*$")


@dataclass(frozen=True)
class NamedQuery:
    name: str
    cypher: str
    description: str
    file: str


def _parse(path: Path) -> list[NamedQuery]:
    out: list[NamedQuery] = []
    name: str | None = None
    desc: list[str] = []
    body: list[str] = []

    def flush() -> None:
        if name:
            text = "\n".join(body).strip()
            if not text:
                raise ValueError(f"{path.name}: query '{name}' is empty")
            out.append(NamedQuery(name, text, " ".join(desc).strip(), path.name))

    for line in path.read_text(encoding="utf-8").splitlines():
        m = _NAME.match(line.strip())
        if m:
            flush()
            name, desc, body = m.group(1), [], []
        elif name and not body and line.strip().startswith("//"):
            desc.append(line.strip().lstrip("/").strip())
        elif name:
            body.append(line)
    flush()
    return out


@lru_cache(maxsize=1)
def catalog() -> dict[str, NamedQuery]:
    folder = settings.queries_dir
    if not folder.is_dir():
        raise FileNotFoundError(f"queries folder not found: {folder} (set QUERIES_DIR)")
    queries: dict[str, NamedQuery] = {}
    for path in sorted(folder.glob("*.cypher")):
        for q in _parse(path):
            if q.name in queries:
                raise ValueError(f"duplicate query name '{q.name}' in {path.name}")
            queries[q.name] = q
    return queries


def cypher(name: str) -> str:
    try:
        return catalog()[name].cypher
    except KeyError:
        raise KeyError(f"unknown query '{name}' - add it to queries/*.cypher") from None
