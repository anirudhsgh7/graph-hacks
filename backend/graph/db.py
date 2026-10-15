"""FalkorDB access: one client, read-only views, and disposable what-if forks.

Two ideas live here:

* `GraphView` - a thin wrapper over one named FalkorDB graph. Tools only call
  `view.ro(name, params)` with a *named* query from queries/*.cypher, so every
  query the product runs is reviewable in one folder.

* Forks - `GRAPH.COPY` the live graph, change the copy (e.g. delete accounts we
  are thinking of freezing), re-run the same algorithms, then drop the copy. The
  live graph is never touched by a simulation.
"""
from __future__ import annotations

import hashlib
import logging
import threading
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

from falkordb import FalkorDB

from app.config import settings
from graph.queries import cypher

log = logging.getLogger(__name__)

FORK_PREFIX = "__fork__"
ACTIVE_PREFIX = "__active__"


class GraphView:
    """A named graph plus helpers that turn results into plain dicts."""

    def __init__(self, graph: Any, name: str, is_fork: bool = False) -> None:
        self.graph = graph
        self.name = name
        self.is_fork = is_fork

    @staticmethod
    def _rows(result: Any) -> list[dict]:
        names = [h[1] if isinstance(h, (list, tuple)) else h for h in (result.header or [])]
        return [dict(zip(names, row)) for row in result.result_set]

    def ro(self, query_name: str, params: dict | None = None, timeout_ms: int = 15000) -> list[dict]:
        return self._rows(self.graph.ro_query(cypher(query_name), params or {}, timeout=timeout_ms))

    def rw(self, query_name: str, params: dict | None = None, timeout_ms: int = 15000) -> list[dict]:
        return self._rows(self.graph.query(cypher(query_name), params or {}, timeout=timeout_ms))


class Database:
    def __init__(self) -> None:
        self._client: FalkorDB | None = None
        self._lock = threading.Lock()
        self._capabilities: dict[str, bool] | None = None
        self._active_name: str | None = None
        self._active_key: str | None = None

    # ---- connection -----------------------------------------------------
    @property
    def client(self) -> FalkorDB:
        if self._client is None:
            kwargs: dict[str, Any] = {
                "host": settings.falkordb_host,
                "port": settings.falkordb_port,
                "socket_timeout": 30,
                "socket_connect_timeout": 5,
            }
            if settings.falkordb_username:
                kwargs["username"] = settings.falkordb_username
            if settings.falkordb_password:
                kwargs["password"] = settings.falkordb_password
            if settings.falkordb_tls:
                kwargs["ssl"] = True
            self._client = FalkorDB(**kwargs)
        return self._client

    def live(self) -> GraphView:
        return GraphView(self.client.select_graph(settings.graph_name), settings.graph_name)

    def ping(self) -> bool:
        try:
            self.client.connection.ping()
            return True
        except Exception:  # pragma: no cover - reported via /api/health
            return False

    # ---- capabilities ---------------------------------------------------
    def capabilities(self) -> dict[str, bool]:
        """Which optional procedures this FalkorDB build has. maxFlow is new; older
        builds get the same answer from our Python implementation (graph/flow.py)."""
        if self._capabilities is None:
            rows = self.live().ro("dbms_procedures")
            names = set(rows[0]["names"]) if rows else set()
            self._capabilities = {
                "maxflow": "algo.maxFlow" in names,
                "sppaths": "algo.SPpaths" in names,
                "wcc": "algo.WCC" in names,
                "cdlp": "algo.labelPropagation" in names,
                "pagerank": "algo.pageRank" in names,
            }
        return self._capabilities

    def disable_native_maxflow(self) -> None:
        caps = self.capabilities()
        caps["maxflow"] = False

    # ---- forks ----------------------------------------------------------
    def _drop(self, name: str) -> None:
        try:
            self.client.select_graph(name).delete()
        except Exception as exc:  # already gone is fine
            log.debug("drop %s: %s", name, exc)

    @contextmanager
    def fork(self, remove_accounts: list[str] | None = None) -> Iterator[GraphView]:
        """Copy the live graph, delete `remove_accounts` from the copy, yield it, drop it."""
        name = f"{settings.graph_name}{FORK_PREFIX}{uuid.uuid4().hex[:10]}"
        self.client.select_graph(settings.graph_name).copy(name)
        view = GraphView(self.client.select_graph(name), name, is_fork=True)
        try:
            if remove_accounts:
                view.rw("fork_remove_accounts", {"ids": list(remove_accounts)})
            yield view
        finally:
            self._drop(name)

    def frozen_accounts(self) -> list[str]:
        return [r["id"] for r in self.live().ro("frozen_accounts")]

    def active(self) -> GraphView:
        """The graph as money can move *today*: frozen accounts removed.

        With nothing frozen this is simply the live graph. Otherwise it is a cached
        fork keyed by the frozen set, rebuilt only when that set changes."""
        frozen = sorted(self.frozen_accounts())
        if not frozen:
            return self.live()
        key = hashlib.sha1(",".join(frozen).encode()).hexdigest()[:10]
        with self._lock:
            if self._active_key != key or self._active_name is None:
                if self._active_name:
                    self._drop(self._active_name)
                name = f"{settings.graph_name}{ACTIVE_PREFIX}{key}"
                self._drop(name)
                self.client.select_graph(settings.graph_name).copy(name)
                GraphView(self.client.select_graph(name), name, True).rw(
                    "fork_remove_accounts", {"ids": frozen})
                self._active_name, self._active_key = name, key
            return GraphView(self.client.select_graph(self._active_name), self._active_name, True)

    def invalidate_active(self) -> None:
        with self._lock:
            if self._active_name:
                self._drop(self._active_name)
            self._active_name = self._active_key = None

    def cleanup_forks(self) -> int:
        """Drop forks left behind by a crash (called at startup and on reseed)."""
        dropped = 0
        for name in self.client.list_graphs():
            if name.startswith(f"{settings.graph_name}{FORK_PREFIX}") or \
                    name.startswith(f"{settings.graph_name}{ACTIVE_PREFIX}"):
                self._drop(name)
                dropped += 1
        self._active_name = self._active_key = None
        return dropped


db = Database()
