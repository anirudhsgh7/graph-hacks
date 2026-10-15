"""Max-flow and minimum vertex cut over the FLOWS_TO network (Dinic's algorithm).

Why this file exists:
  * Minimum cut is the question an AML team actually asks - "what is the
    *smallest* set of accounts we can freeze that stops every route from these
    mules to the cash-out?" - and no FalkorDB procedure answers it directly. By the
    max-flow/min-cut theorem we can: split every account into an in-node and an
    out-node joined by an edge whose capacity is the *cost* of freezing it, give
    money edges infinite capacity, and the minimum cut is the cheapest freeze set.
  * FalkorDB builds that predate algo.maxFlow still get the same capacity number.

Every recommendation produced here is then re-checked inside FalkorDB on a fork of
the graph (see agent/tools.py): accounts deleted, algorithms re-run, zero routes.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

INF = float("inf")
EPS = 1e-9


class _Dinic:
    def __init__(self) -> None:
        self.index: dict[object, int] = {}
        self.adj: list[list[int]] = []
        # Edge arrays: to, capacity, flow. Edge i and i^1 are a forward/reverse pair.
        self.to: list[int] = []
        self.cap: list[float] = []
        self.flow: list[float] = []

    def node(self, key: object) -> int:
        if key not in self.index:
            self.index[key] = len(self.adj)
            self.adj.append([])
        return self.index[key]

    def add_edge(self, u: object, v: object, capacity: float) -> int:
        a, b = self.node(u), self.node(v)
        eid = len(self.to)
        self.to += [b, a]
        self.cap += [capacity, 0.0]
        self.flow += [0.0, 0.0]
        self.adj[a].append(eid)
        self.adj[b].append(eid + 1)
        return eid

    def _residual(self, e: int) -> float:
        return self.cap[e] - self.flow[e]

    def max_flow(self, s: object, t: object) -> float:
        src, snk = self.node(s), self.node(t)
        total = 0.0
        while True:
            level = [-1] * len(self.adj)
            level[src] = 0
            q = deque([src])
            while q:
                u = q.popleft()
                for e in self.adj[u]:
                    if self._residual(e) > EPS and level[self.to[e]] < 0:
                        level[self.to[e]] = level[u] + 1
                        q.append(self.to[e])
            if level[snk] < 0:
                return total
            it = [0] * len(self.adj)

            def push(u: int, limit: float) -> float:
                # Iterative DFS would be longer; graph depth here is small (< 40 levels).
                if u == snk:
                    return limit
                while it[u] < len(self.adj[u]):
                    e = self.adj[u][it[u]]
                    v = self.to[e]
                    if self._residual(e) > EPS and level[v] == level[u] + 1:
                        pushed = push(v, min(limit, self._residual(e)))
                        if pushed > EPS:
                            self.flow[e] += pushed
                            self.flow[e ^ 1] -= pushed
                            return pushed
                    it[u] += 1
                return 0.0

            while True:
                pushed = push(src, INF)
                if pushed <= EPS:
                    break
                if pushed == INF:  # an all-infinite route: the cut is unbounded
                    return INF
                total += pushed

    def reachable_from(self, s: object) -> set[int]:
        start = self.node(s)
        seen = {start}
        q = deque([start])
        while q:
            u = q.popleft()
            for e in self.adj[u]:
                if self._residual(e) > EPS and self.to[e] not in seen:
                    seen.add(self.to[e])
                    q.append(self.to[e])
        return seen

    def reaching(self, t: object) -> set[int]:
        """Nodes that can still reach t in the residual graph (sink-side of the cut)."""
        target = self.node(t)
        seen = {target}
        q = deque([target])
        while q:
            v = q.popleft()
            for e in self.adj[v]:
                # e goes v -> u; its pair (e ^ 1) goes u -> v. u reaches v if that pair has residual.
                u = self.to[e]
                if self._residual(e ^ 1) > EPS and u not in seen:
                    seen.add(u)
                    q.append(u)
        return seen


_SOURCE, _SINK = ("__S__",), ("__T__",)


@dataclass
class FlowResult:
    value: float
    edge_flows: list[tuple[str, str, float, float]] = field(default_factory=list)  # src, dst, flow, capacity
    engine: str = "python"


def max_flow(edges: list[tuple[str, str, float]], sources: list[str], sinks: list[str],
             exclude: set[str] | None = None) -> FlowResult:
    """Maximum money that can move from any source to any sink. `exclude` = frozen accounts."""
    exclude = exclude or set()
    srcs = [s for s in sources if s not in exclude]
    snks = [t for t in sinks if t not in exclude]
    if not srcs or not snks:
        return FlowResult(0.0)
    g = _Dinic()
    ids: list[tuple[int, str, str, float]] = []
    for u, v, cap in edges:
        if u in exclude or v in exclude or u == v or cap <= 0:
            continue
        ids.append((g.add_edge(u, v, float(cap)), u, v, float(cap)))
    for s in srcs:
        g.add_edge(_SOURCE, s, INF)
    for t in snks:
        g.add_edge(t, _SINK, INF)
    value = g.max_flow(_SOURCE, _SINK)
    flows = [(u, v, round(g.flow[e], 2), cap) for e, u, v, cap in ids if g.flow[e] > EPS]
    flows.sort(key=lambda r: -r[2])
    return FlowResult(round(value, 2), flows)


@dataclass
class CutResult:
    accounts: list[str]
    cost: float
    feasible: bool


def min_vertex_cut(edges: list[tuple[str, str, float]], sources: list[str], sinks: list[str],
                   node_cost: dict[str, float], exclude: set[str] | None = None) -> CutResult:
    """Cheapest set of accounts whose removal disconnects every source from every sink.

    Sources may be frozen themselves (they are mules too); sinks may not (they are the
    destination we are protecting against). Nodes absent from node_cost cost 1.0.
    Among equally cheap cuts the one closest to the sinks is returned, which stops the
    money as late as possible and therefore covers every upstream route."""
    exclude = exclude or set()
    sink_set = set(sinks)
    g = _Dinic()
    nodes: set[str] = set()
    for u, v, cap in edges:
        if u in exclude or v in exclude or u == v or cap <= 0:
            continue
        nodes.update((u, v))
        g.add_edge((u, "out"), (v, "in"), INF)
    split: dict[str, int] = {}
    for n in nodes | set(sources):
        cost = INF if n in sink_set else float(node_cost.get(n, 1.0))
        split[n] = g.add_edge((n, "in"), (n, "out"), cost)
    for s in sources:
        if s not in exclude:
            g.add_edge(_SOURCE, (s, "in"), INF)
    for t in sinks:
        if t not in exclude:
            g.add_edge((t, "in"), _SINK, INF)
    value = g.max_flow(_SOURCE, _SINK)
    if value == INF:
        return CutResult([], INF, False)
    sink_side = g.reaching(_SINK)
    cut = sorted(n for n, e in split.items()
                 if g.index[(n, "in")] not in sink_side and g.index[(n, "out")] in sink_side)
    return CutResult(cut, round(value, 4), True)
