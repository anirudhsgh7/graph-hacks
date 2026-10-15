"""Evidence: the object every claim in an investigation must point at.

A tool that learns something from the graph registers an Evidence record and
hands its id (ev-1, ev-2, ...) to the agent. Findings may only cite these ids;
anything else is stripped before the response leaves the server.

Each record also carries *receipts*: the named query and parameters that produced
it, so a judge can paste the same Cypher into FalkorDB Browser, or press "replay"
in the UI (POST /api/evidence/replay), and get the same rows back.
"""
from __future__ import annotations

import hashlib
import json
import threading
from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class Receipt:
    query: str
    params: dict[str, Any]

    def fingerprint(self, rows: list[dict]) -> str:
        return fingerprint(rows)


def fingerprint(rows: list[dict]) -> str:
    """Stable hash of query results (order-insensitive, floats rounded)."""
    def norm(v: Any) -> Any:
        if isinstance(v, float):
            return round(v, 6)
        if isinstance(v, list):
            return [norm(x) for x in v]
        if isinstance(v, dict):
            return {k: norm(x) for k, x in sorted(v.items())}
        return v
    canon = sorted(json.dumps(norm(r), sort_keys=True, default=str) for r in rows)
    return hashlib.sha256("\n".join(canon).encode()).hexdigest()[:16]


@dataclass
class Evidence:
    id: str
    type: str          # profile | shared_entities | community | path | no_path | pattern |
                       # ranking | capacity | simulation | freeze_plan
    tool: str
    node_ids: list[str]
    edge_ids: list[str]
    result_excerpt: dict[str, Any]
    receipts: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class EvidenceLog:
    def __init__(self) -> None:
        self._items: dict[str, Evidence] = {}
        self._lock = threading.Lock()

    def add(self, type_: str, tool: str, node_ids: list[str], edge_ids: list[str],
            excerpt: dict[str, Any], receipts: list[Receipt] | None = None) -> str:
        with self._lock:
            eid = f"ev-{len(self._items) + 1}"
            self._items[eid] = Evidence(
                id=eid, type=type_, tool=tool,
                node_ids=list(dict.fromkeys(node_ids)), edge_ids=list(dict.fromkeys(edge_ids)),
                result_excerpt=excerpt,
                receipts=[{"query": r.query, "params": r.params} for r in (receipts or [])],
            )
            return eid

    def get(self, eid: str) -> Evidence | None:
        return self._items.get(eid)

    def all(self) -> list[Evidence]:
        return list(self._items.values())

    def of_type(self, *types: str) -> list[Evidence]:
        return [e for e in self._items.values() if e.type in types]

    def __contains__(self, eid: object) -> bool:
        return eid in self._items
