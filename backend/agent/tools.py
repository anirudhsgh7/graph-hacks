"""The agent's tools. Each one runs fixed, parameterised Cypher (queries/*.cypher)
against FalkorDB and returns compact JSON plus evidence ids. The model chooses
tools and fills parameters; it never writes Cypher and never writes to the graph.

Two views of the graph are used:
  run.live    - the graph as recorded (profiles, devices, rings, history).
  run.active  - the graph as money can move *today*: frozen accounts removed.
                Trails, capacity and freeze plans always use this view.
"""
from __future__ import annotations

import logging
import statistics
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from agent.evidence import EvidenceLog, Receipt
from graph.db import Database, GraphView
from graph.flow import FlowResult, max_flow, min_vertex_cut
from seed.generator import NOW as DATA_AS_OF  # "today" in the synthetic world

log = logging.getLogger(__name__)

MIN = 60_000
# Thresholds behind the deterministic ring verdict. Kept here, in one place, so the
# rule the product applies can be read and challenged.
RING_MIN_SIZE = 3
RING_MIN_PASS_THROUGH = 0.85     # members forward at least 85% of what they receive
RING_MAX_FORWARD_MINUTES = 60    # typical gap between money arriving and leaving
STRONG_TRAIL_MAX_HOP_MINUTES = 120
MAX_RESPONSE_ITEMS = 15


class ToolError(Exception):
    """Bad input the model can correct (unknown account, empty list...)."""


@dataclass
class Run:
    """State for one investigation: database handles, evidence, and trace."""
    db: Database
    evidence: EvidenceLog = field(default_factory=EvidenceLog)
    _live: GraphView | None = None
    _active: GraphView | None = None

    @property
    def live(self) -> GraphView:
        if self._live is None:
            self._live = self.db.live()
        return self._live

    @property
    def active(self) -> GraphView:
        if self._active is None:
            self._active = self.db.active()
        return self._active

    def frozen(self) -> set[str]:
        return set(self.db.frozen_accounts())


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def iso(ms: int | float | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def money(x: float | None) -> float:
    return round(float(x or 0.0), 2)


def _norm_id(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ToolError("account ids must be non-empty strings like 'A17'")
    return raw.strip().upper()


def _norm_ids(raw: Any, name: str) -> list[str]:
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        raise ToolError(f"'{name}' must be a non-empty list of account ids")
    return list(dict.fromkeys(_norm_id(x) for x in raw))


def _require_accounts(run: Run, ids: list[str]) -> dict[str, dict]:
    rows = {r["id"]: r for r in run.live.ro("accounts_by_id", {"ids": ids})}
    missing = [i for i in ids if i not in rows]
    if missing:
        raise ToolError(f"unknown account(s): {', '.join(missing)} - use search_accounts")
    return rows


def _natural(account_id: str) -> tuple:
    """A9 < A17 < A101, H1 < H3."""
    head = account_id.rstrip("0123456789")
    tail = account_id[len(head):]
    return (head, int(tail) if tail else -1)


FUNDING_MATCH = 0.85   # an inflow "funds" an outflow if it is at least 85% of its size


def _forward_gaps(transfers: list[dict], accounts: set[str]) -> tuple[list[float], float, float]:
    """How long money stays before being passed on.

    For every outflow we look back for the most recent inflow (within 7 days) large
    enough to have paid for it (>= 85% of the amount); the time between them is a
    forwarding gap. A merchant's nightly settlement is not matched by any single card
    payment, so it is correctly *not* treated as forwarding.

    Returns (gaps in minutes, volume forwarded within 60 minutes, total outflow)."""
    inflows: dict[str, list[tuple[int, float]]] = defaultdict(list)
    gaps: list[float] = []
    fast, total_out = 0.0, 0.0
    for t in sorted(transfers, key=lambda r: r["ts"]):
        if t["src"] in accounts:
            total_out += t["amount"]
            for when, amount in reversed(inflows[t["src"]]):
                if t["ts"] - when > 7 * 24 * 60 * MIN:
                    break
                if amount >= FUNDING_MATCH * t["amount"]:
                    gap = (t["ts"] - when) / MIN
                    gaps.append(gap)
                    if gap <= 60:
                        fast += t["amount"]
                    break
        if t["dst"] in accounts:
            inflows[t["dst"]].append((t["ts"], t["amount"]))
    return gaps, fast, total_out


FLOW_PAGE = 1000


def _flow_edges(view: GraphView) -> tuple[list[tuple[str, str, float]], Receipt]:
    """All FLOWS_TO edges, read page by page. FalkorDB silently caps result sets
    (RESULTSET_SIZE), so we count first and keep paging until every edge has arrived."""
    total = view.ro("flow_edge_count")[0]["total"]
    edges: list[tuple[str, str, float]] = []
    while len(edges) < total:
        rows = view.ro("flow_edges", {"skip": len(edges), "limit": FLOW_PAGE})
        if not rows:
            raise RuntimeError(f"FLOWS_TO read stopped at {len(edges)} of {total} edges")
        edges.extend((r["src"], r["dst"], float(r["capacity"])) for r in rows)
    return edges, Receipt("flow_edge_count", {})


def compute_capacity(run: Run, view: GraphView, sources: list[str], sinks: list[str],
                     exclude: set[str] | None = None) -> tuple[FlowResult, list[Receipt]]:
    """Max-flow from sources to sinks. Uses FalkorDB's algo.maxFlow when the build has
    it (and nothing needs excluding); otherwise the identical computation in Python on
    the FLOWS_TO edges read from FalkorDB."""
    exclude = exclude or set()
    srcs = [s for s in sources if s not in exclude]
    snks = [t for t in sinks if t not in exclude]
    if not srcs or not snks:
        return FlowResult(0.0, [], "trivial"), []
    if not exclude and run.db.capabilities().get("maxflow"):
        params = {"sources": srcs, "sinks": snks}
        try:
            rows = view.ro("maxflow_native", params)
            if rows:
                r = rows[0]
                pairs = r.get("pairs") or []
                flows = r.get("flows") or []
                caps = {(u, v): c for u, v, c in _flow_edges(view)[0]}
                edge_flows = sorted(
                    [(p[0], p[1], money(f), caps.get((p[0], p[1]), 0.0))
                     for p, f in zip(pairs, flows) if f and f > 0],
                    key=lambda x: -x[2])
                return FlowResult(money(r["max_flow"]), edge_flows, "falkordb"), \
                    [Receipt("maxflow_native", params)]
        except Exception as exc:  # e.g. an unexpected result shape on a new build
            log.warning("algo.maxFlow failed (%s); using the Python solver", exc)
            run.db.disable_native_maxflow()
    edges, receipt = _flow_edges(view)
    result = max_flow(edges, srcs, snks, exclude)
    result.engine = "python"
    return result, [receipt]


def _route_avoiding(edges: list[tuple[str, str, float]], sources: list[str], sinks: list[str],
                    exclude: set[str]) -> list[str] | None:
    """Shortest remaining route (by hops) from any source to any sink, or None."""
    adj: dict[str, list[str]] = defaultdict(list)
    for u, v, _ in edges:
        if u not in exclude and v not in exclude:
            adj[u].append(v)
    targets = set(sinks) - exclude
    q = deque([[s] for s in sorted(set(sources) - exclude)])
    seen = {p[0] for p in q}
    while q:
        path = q.popleft()
        if path[-1] in targets:
            return path
        if len(path) > 8:
            continue
        for nxt in sorted(adj[path[-1]]):
            if nxt not in seen:
                seen.add(nxt)
                q.append(path + [nxt])
    return None


def _realize_path(view: GraphView, nodes: list[str]) -> dict:
    """Turn a node path into actual transfers, in time order if one exists."""
    pairs = [[nodes[i], nodes[i + 1]] for i in range(len(nodes) - 1)]
    rows = view.ro("hop_transfers", {"pairs": pairs})
    per_hop: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for r in rows:
        per_hop[(r["src"], r["dst"])].append(r)
    hops = [sorted(per_hop[(a, b)], key=lambda r: r["ts"]) for a, b in pairs]
    best: list[dict] | None = None
    for first in hops[0]:
        chain = [first]
        for options in hops[1:]:
            nxt = next((t for t in options if t["ts"] > chain[-1]["ts"]
                        and t["ts"] - chain[-1]["ts"] <= 24 * 60 * MIN), None)
            if nxt is None:
                break
            chain.append(nxt)
        if len(chain) == len(hops):
            retained = chain[-1]["amount"] / chain[0]["amount"]
            if best is None or retained > best[-1]["amount"] / best[0]["amount"]:
                best = chain
    if best:
        gaps = [(best[i + 1]["ts"] - best[i]["ts"]) / MIN for i in range(len(best) - 1)]
        amount_ok = all(best[i + 1]["amount"] <= best[i]["amount"] for i in range(len(best) - 1))
        max_gap = max(gaps) if gaps else 0.0
        quality = "strong" if amount_ok and max_gap <= STRONG_TRAIL_MAX_HOP_MINUTES else "weak"
        return {
            "nodes": nodes, "hops": len(pairs), "time_ordered": True, "amount_consistent": amount_ok,
            "quality": quality,
            "minutes_total": round((best[-1]["ts"] - best[0]["ts"]) / MIN, 1),
            "max_hop_minutes": round(max_gap, 1),
            "start_amount": money(best[0]["amount"]), "end_amount": money(best[-1]["amount"]),
            "retained_pct": round(100 * best[-1]["amount"] / best[0]["amount"], 1),
            "transfers": [{"id": t["id"], "from": t["src"], "to": t["dst"], "amount": money(t["amount"]),
                           "at": iso(t["ts"])} for t in best],
        }
    totals = [money(sum(t["amount"] for t in h)) for h in hops]
    return {
        "nodes": nodes, "hops": len(pairs), "time_ordered": False, "amount_consistent": False,
        "quality": "structural",
        "note": "accounts are linked, but no time-ordered sequence of transfers follows this route",
        "hop_totals": totals,
        "transfers": [{"id": h[-1]["id"], "from": h[-1]["src"], "to": h[-1]["dst"],
                       "amount": money(h[-1]["amount"]), "at": iso(h[-1]["ts"])} for h in hops if h],
    }


# ---------------------------------------------------------------------------
# tools
# ---------------------------------------------------------------------------
def search_accounts(run: Run, query: str) -> dict:
    if not isinstance(query, str) or not query.strip():
        raise ToolError("query must be a non-empty string")
    rows = run.live.ro("account_search", {"q": query.strip()})
    return {"matches": [{"id": r["id"], "type": r["type"], "status": r["status"], "owner": r["owner"],
                         "anomaly_score": r["anomaly_score"]} for r in rows]}


def account_profile(run: Run, account_id: str) -> dict:
    acc = _norm_id(account_id)
    rows = run.live.ro("account_profile", {"id": acc})
    if not rows:
        raise ToolError(f"unknown account {acc} - use search_accounts")
    p = rows[0]
    rank_row = run.live.ro("anomaly_rank", {"score": p["anomaly_score"]})[0]
    rank = int(rank_row["higher"]) + 1
    senders = run.live.ro("inbound_sender_repeats", {"id": acc})
    one_time = sum(1 for s in senders if s["times"] == 1)
    transfers = run.live.ro("account_transfers", {"ids": [acc]})
    gaps, fast, total_out = _forward_gaps(transfers, {acc})
    same_owner = [r["id"] for r in run.live.ro("account_owned_by_same_customer", {"id": acc})]
    age_days = (DATA_AS_OF.timestamp() * 1000 - p["opened_at"]) / 86_400_000
    data = {
        "account": acc, "owner": p["owner"], "type": p["type"], "status": p["status"],
        "country": p["country"], "opened": iso(p["opened_at"]), "account_age_days": int(age_days),
        "anomaly_score": p["anomaly_score"], "anomaly_rank": rank, "accounts_ranked": int(rank_row["total"]),
        "anomaly_top_pct": round(100 * rank / int(rank_row["total"]), 1),
        "inbound": {"count": p["in_count"], "total": money(p["in_total"]),
                    "distinct_senders": p["in_counterparties"],
                    "one_time_sender_share": round(one_time / len(senders), 3) if senders else None},
        "outbound": {"count": p["out_count"], "total": money(p["out_total"]),
                     "distinct_recipients": p["out_counterparties"]},
        "forwarded_within_60_min_share": round(fast / total_out, 3) if total_out else 0.0,
        "median_minutes_money_stays": round(statistics.median(gaps), 1) if gaps else None,
        "other_accounts_same_owner": same_owner,
    }
    data["evidence_id"] = run.evidence.add(
        "profile", "account_profile", [acc] + same_owner, [],
        {k: data[k] for k in ("anomaly_score", "anomaly_rank", "anomaly_top_pct",
                              "forwarded_within_60_min_share", "median_minutes_money_stays")}
        | {"distinct_senders": p["in_counterparties"], "one_time_sender_share":
           data["inbound"]["one_time_sender_share"], "type": p["type"]},
        [Receipt("account_profile", {"id": acc}), Receipt("anomaly_rank", {"score": p["anomaly_score"]}),
         Receipt("inbound_sender_repeats", {"id": acc})])
    return data


def shared_infrastructure(run: Run, account_id: str) -> dict:
    acc = _norm_id(account_id)
    _require_accounts(run, [acc])
    rows = run.live.ro("shared_infrastructure", {"id": acc})
    linked: dict[str, list[str]] = defaultdict(list)
    devices, ips = set(), set()
    for r in rows:
        linked[r["account"]].append(r["via_id"])
        (devices if r["via_kind"] == "Device" else ips).add(r["via_id"])
    data = {
        "account": acc,
        "linked_accounts": [{"account": a, "via": sorted(set(v))} for a, v in sorted(linked.items())],
        "shared_devices": sorted(devices), "shared_ips": sorted(ips),
    }
    data["evidence_id"] = run.evidence.add(
        "shared_entities", "shared_infrastructure", [acc, *linked, *devices, *ips], [],
        {"linked_accounts": len(linked), "shared_devices": len(devices), "shared_ips": len(ips)},
        [Receipt("shared_infrastructure", {"id": acc})])
    return data


def detect_ring(run: Run, account_ids: list[str]) -> dict:
    seeds = _norm_ids(account_ids, "account_ids")
    _require_accounts(run, seeds)
    comps = run.live.ro("infrastructure_components", {"ids": seeds})
    groups_out, unlinked = [], []
    for comp in sorted(comps, key=lambda c: -len(c["members"])):
        members = sorted(comp["members"], key=_natural)
        if len(members) < 2:
            unlinked.extend(members)
            continue
        mset = set(members)
        links = run.live.ro("shared_infrastructure_among", {"ids": members})
        devices = sorted({l["via_id"] for l in links if l["via_kind"] == "Device"})
        ips = sorted({l["via_id"] for l in links if l["via_kind"] != "Device"})
        transfers = run.live.ro("account_transfers", {"ids": members})
        internal = [t for t in transfers if t["src"] in mset and t["dst"] in mset]
        in_total = sum(t["amount"] for t in transfers if t["dst"] in mset)
        out_total = sum(t["amount"] for t in transfers if t["src"] in mset)
        gaps, _fast, _ = _forward_gaps(transfers, mset)
        pass_through = out_total / in_total if in_total else 0.0
        median_gap = statistics.median(gaps) if gaps else None
        entries: dict[str, list] = defaultdict(lambda: [0.0, set()])
        exits: dict[str, float] = defaultdict(float)
        exit_from: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
        for t in transfers:
            if t["dst"] in mset and t["src"] not in mset:
                entries[t["dst"]][0] += t["amount"]
                entries[t["dst"]][1].add(t["src"])
            if t["src"] in mset and t["dst"] not in mset:
                exits[t["dst"]] += t["amount"]
                exit_from[t["src"]][t["dst"]] += t["amount"]
        is_ring = (len(members) >= RING_MIN_SIZE and pass_through >= RING_MIN_PASS_THROUGH
                   and median_gap is not None and median_gap <= RING_MAX_FORWARD_MINUTES)
        reasons = [
            f"{len(members)} accounts tied together by {len(devices)} shared device(s) and {len(ips)} shared IP(s)",
            f"members forward {round(100 * pass_through)}% of the money they receive "
            f"(ring threshold {round(100 * RING_MIN_PASS_THROUGH)}%)",
            ("money typically leaves a member " + (f"{round(median_gap)} minutes" if median_gap is not None
                                                  else "never") +
             f" after it arrives (ring threshold {RING_MAX_FORWARD_MINUTES} minutes)"),
        ]
        group = {
            "members": members, "size": len(members),
            "verdict": "mule_ring" if is_ring else "shared_infrastructure_only",
            "reasons": reasons,
            "shared_devices": devices, "shared_ips": ips,
            "signals": {
                "pass_through_ratio": round(pass_through, 3),
                "median_forward_minutes": round(median_gap, 1) if median_gap is not None else None,
                "internal_transfers": len(internal),
                "money_in": money(in_total), "money_out": money(out_total),
            },
            "entry_points": [{"account": a, "received_from_outside": money(v[0]), "senders": len(v[1])}
                             for a, v in sorted(entries.items(), key=lambda kv: -kv[1][0])],
            "cashout_candidates": [{"account": a, "received_from_group": money(v)}
                                   for a, v in sorted(exits.items(), key=lambda kv: -kv[1])[:5]],
            "exit_points": [{"account": m, "to": [{"account": d, "amount": money(v)} for d, v in
                                                  sorted(dests.items(), key=lambda kv: -kv[1])[:3]]}
                            for m, dests in sorted(exit_from.items())],
        }
        group["evidence_id"] = run.evidence.add(
            "community", "detect_ring", members + devices + ips,
            [t["id"] for t in internal][:60],
            {"community_size": len(members), "verdict": group["verdict"],
             "pass_through_ratio": group["signals"]["pass_through_ratio"],
             "median_forward_minutes": group["signals"]["median_forward_minutes"],
             "shared_devices": len(devices), "shared_ips": len(ips),
             "seed_nodes_covered": len([s for s in seeds if s in mset]),
             "entry_points": [e["account"] for e in group["entry_points"]],
             "cashout_candidates": [c["account"] for c in group["cashout_candidates"]]},
            [Receipt("infrastructure_components", {"ids": seeds}),
             Receipt("shared_infrastructure_among", {"ids": members}),
             Receipt("account_transfers", {"ids": members})])
        groups_out.append(group)
    if not groups_out:
        eid = run.evidence.add("community", "detect_ring", seeds, [],
                               {"community_size": 1, "verdict": "no_ring", "shared_devices": 0,
                                "shared_ips": 0, "seed_nodes_covered": len(seeds)},
                               [Receipt("infrastructure_components", {"ids": seeds})])
        return {"verdict": "no_ring", "groups": [], "unlinked_accounts": sorted(set(unlinked)),
                "note": "none of these accounts shares a device or IP with any other account",
                "evidence_id": eid}
    verdict = "mule_ring" if any(g["verdict"] == "mule_ring" for g in groups_out) \
        else "shared_infrastructure_only"
    return {"verdict": verdict, "groups": groups_out, "unlinked_accounts": sorted(set(unlinked))}


def money_trail(run: Run, src: str, dst: str, max_len: int = 6, path_count: int = 5) -> dict:
    s, t = _norm_id(src), _norm_id(dst)
    if s == t:
        raise ToolError("src and dst must differ")
    _require_accounts(run, [s, t])
    max_len = max(1, min(int(max_len), 8))
    path_count = max(1, min(int(path_count), 8))
    frozen = run.frozen()
    if s in frozen or t in frozen:
        raise ToolError(f"{s if s in frozen else t} is frozen; money cannot move through it")
    params = {"src": s, "dst": t, "max_len": max_len, "path_count": path_count}
    rows = run.active.ro("money_trail_paths", params)
    if not rows:
        eid = run.evidence.add("no_path", "money_trail", [s, t], [],
                               {"src": s, "dst": t, "max_len": max_len, "paths": 0,
                                "frozen_excluded": sorted(frozen)},
                               [Receipt("money_trail_paths", params)])
        return {"src": s, "dst": t, "paths": [], "evidence_id": eid,
                "note": f"no route from {s} to {t} within {max_len} hops"
                        + (" (frozen accounts excluded)" if frozen else "")}
    paths = []
    order = {"strong": 0, "weak": 1, "structural": 2}
    for r in rows:
        p = _realize_path(run.active, r["nodes"])
        pairs = [[r["nodes"][i], r["nodes"][i + 1]] for i in range(len(r["nodes"]) - 1)]
        excerpt = {k: p[k] for k in ("hops", "quality", "time_ordered", "amount_consistent")}
        excerpt |= {k: p[k] for k in ("minutes_total", "max_hop_minutes", "start_amount", "end_amount",
                                       "retained_pct") if k in p}
        p["evidence_id"] = run.evidence.add(
            "path", "money_trail", r["nodes"], [x["id"] for x in p["transfers"]], excerpt,
            [Receipt("money_trail_paths", params), Receipt("hop_transfers", {"pairs": pairs})])
        paths.append(p)
    paths.sort(key=lambda p: (order[p["quality"]], p["hops"]))
    return {"src": s, "dst": t, "paths": paths,
            "strong_paths": sum(1 for p in paths if p["quality"] == "strong"),
            "frozen_excluded": sorted(frozen)}


def follow_funds(run: Run, account_id: str, transfer_id: str | None = None, window_minutes: int = 60,
                 min_retained: float = 0.85, max_hops: int = 6) -> dict:
    acc = _norm_id(account_id)
    _require_accounts(run, [acc])
    window = max(5, min(int(window_minutes), 24 * 60))
    min_retained = max(0.5, min(float(min_retained), 1.0))
    max_hops = max(1, min(int(max_hops), 8))
    receipts: list[Receipt] = []
    if transfer_id:
        start = run.live.ro("transfer_by_id", {"id": transfer_id})
        receipts.append(Receipt("transfer_by_id", {"id": transfer_id}))
        if not start or start[0]["src"] != acc:
            raise ToolError(f"transfer {transfer_id} is not an outgoing transfer of {acc}")
        cur = start[0]
    else:
        start = run.live.ro("largest_outflow", {"id": acc})
        receipts.append(Receipt("largest_outflow", {"id": acc}))
        if not start:
            raise ToolError(f"{acc} has no outgoing transfers")
        cur = dict(start[0], src=acc)
    frozen = run.frozen()
    hops = [{"from": acc, "to": cur["dst"], "transfer_id": cur["id"], "amount": money(cur["amount"]),
             "at": iso(cur["ts"]), "minutes_after_previous": None, "fee_pct": None}]
    visited = {acc, cur["dst"]}
    stop_reason = "max_hops reached"
    while len(hops) < max_hops:
        if cur["dst"] in frozen:
            stop_reason = f"{cur['dst']} is frozen"
            break
        params = {"id": cur["dst"], "after": cur["ts"], "until": cur["ts"] + window * MIN,
                  "max_amount": cur["amount"], "min_amount": cur["amount"] * min_retained}
        nxt = [r for r in run.live.ro("onward_transfers", params) if r["dst"] not in visited]
        receipts.append(Receipt("onward_transfers", params))
        if not nxt:
            stop_reason = (f"no onward transfer from {cur['dst']} within {window} minutes "
                           f"keeping at least {round(100 * min_retained)}% of the amount (funds pooled or spent)")
            break
        n = nxt[0]
        hops.append({"from": cur["dst"], "to": n["dst"], "transfer_id": n["id"], "amount": money(n["amount"]),
                     "at": iso(n["ts"]), "minutes_after_previous": round((n["ts"] - cur["ts"]) / MIN, 1),
                     "fee_pct": round(100 * (1 - n["amount"] / cur["amount"]), 2)})
        visited.add(n["dst"])
        cur = dict(n, src=hops[-1]["from"])
    end = hops[-1]["to"]
    end_info = _require_accounts(run, [end])[end]
    nodes = [acc] + [h["to"] for h in hops]
    first_ms = datetime.strptime(hops[0]["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    last_ms = datetime.strptime(hops[-1]["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    fees = [h["fee_pct"] for h in hops if h["fee_pct"] is not None]
    data = {
        "start_account": acc, "hops": hops, "hop_count": len(hops), "end_account": end,
        "end_account_type": end_info["type"],
        "minutes_total": round((last_ms - first_ms).total_seconds() / 60, 1),
        "start_amount": hops[0]["amount"], "end_amount": hops[-1]["amount"],
        "fee_per_hop_pct": {"min": min(fees), "max": max(fees)} if fees else None,
        "stopped_because": stop_reason,
    }
    data["evidence_id"] = run.evidence.add(
        "path", "follow_funds", nodes, [h["transfer_id"] for h in hops],
        {"hops": len(hops), "quality": "strong" if len(hops) >= 2 else "single_transfer",
         "minutes_total": data["minutes_total"], "start_amount": data["start_amount"],
         "end_amount": data["end_amount"], "end_account": end, "fee_per_hop_pct": data["fee_per_hop_pct"]},
        receipts)
    return data


def rank_hubs(run: Run, limit: int = 10) -> dict:
    limit = max(1, min(int(limit), 25))
    rows = run.live.ro("rank_hubs", {"limit": limit})
    ranked = [{"rank": i + 1, "account": r["account"], "type": r["type"], "status": r["status"],
               "score": round(r["score"], 6)} for i, r in enumerate(rows)]
    eid = run.evidence.add("ranking", "rank_hubs", [r["account"] for r in ranked], [],
                           {"top": [r["account"] for r in ranked]}, [Receipt("rank_hubs", {"limit": limit})])
    return {"ranking": ranked, "algorithm": "PageRank over TRANSFER", "evidence_id": eid}


def layering_scan(run: Run, account_ids: list[str], window_minutes: int = 60,
                  fee_tolerance: float = 0.1) -> dict:
    ids = _norm_ids(account_ids, "account_ids")
    _require_accounts(run, ids)
    params = {"ids": ids, "window_ms": max(1, min(int(window_minutes), 1440)) * MIN,
              "fee_tolerance": max(0.0, min(float(fee_tolerance), 0.5))}
    rows = run.live.ro("layering_pairs", params)
    by_via: dict[str, int] = defaultdict(int)
    for r in rows:
        by_via[r["via"]] += 1
    patterns = [{"from": r["src"], "via": r["via"], "to": r["dst"], "in_amount": money(r["in_amount"]),
                 "out_amount": money(r["out_amount"]), "minutes_between": round(r["gap_ms"] / MIN, 1),
                 "in_transfer": r["in_id"], "out_transfer": r["out_id"]} for r in rows]
    eid = run.evidence.add(
        "pattern", "layering_scan",
        list(dict.fromkeys(n for r in rows for n in (r["src"], r["via"], r["dst"]))) or ids,
        [x for r in rows for x in (r["in_id"], r["out_id"])],
        {"pass_through_patterns": len(rows), "accounts_with_pattern": len(by_via),
         "window_minutes": params["window_ms"] // MIN},
        [Receipt("layering_pairs", params)])
    return {"pass_through_patterns": len(rows), "per_account": dict(sorted(by_via.items())),
            "examples": patterns[:MAX_RESPONSE_ITEMS], "evidence_id": eid,
            "note": None if rows else "no money passed through these accounts in this window"}


def _endpoints(run: Run, entry_ids: Any, hub_ids: Any) -> tuple[list[str], list[str]]:
    entries = _norm_ids(entry_ids, "entry_ids")
    hubs = _norm_ids(hub_ids, "hub_ids")
    if set(entries) & set(hubs):
        raise ToolError("entry_ids and hub_ids must not overlap")
    _require_accounts(run, entries + hubs)
    return entries, hubs


def laundering_capacity(run: Run, entry_ids: list[str], hub_ids: list[str]) -> dict:
    entries, hubs = _endpoints(run, entry_ids, hub_ids)
    frozen = run.frozen()
    result, receipts = compute_capacity(run, run.active, [e for e in entries if e not in frozen],
                                        [h for h in hubs if h not in frozen])
    flows = result.edge_flows
    nodes = list(dict.fromkeys([*entries, *hubs] + [n for u, v, *_ in flows for n in (u, v)]))
    bottlenecks = [{"from": u, "to": v, "capacity": money(c)} for u, v, f, c in flows if c and f >= c - 0.01]
    data = {
        "entry_ids": entries, "hub_ids": hubs, "capacity": result.value, "engine": result.engine,
        "unit": "USD observed on the money paths (sum of transfers per account pair)",
        "flows": [{"from": u, "to": v, "flow": f, "capacity": money(c)} for u, v, f, c in flows][:MAX_RESPONSE_ITEMS],
        "bottlenecks": bottlenecks[:5], "accounts_carrying_money": len(nodes),
        "frozen_excluded": sorted(frozen),
    }
    data["evidence_id"] = run.evidence.add(
        "capacity", "laundering_capacity", nodes, [],
        {"capacity": result.value, "engine": result.engine, "entry_ids": entries, "hub_ids": hubs,
         "flow_pairs": [[u, v] for u, v, *_ in flows][:40]}, receipts)
    return data


def simulate_freeze(run: Run, freeze_ids: list[str], entry_ids: list[str], hub_ids: list[str]) -> dict:
    freeze = _norm_ids(freeze_ids, "freeze_ids")
    entries, hubs = _endpoints(run, entry_ids, hub_ids)
    _require_accounts(run, freeze)
    if set(freeze) & set(hubs):
        raise ToolError("a hub is the destination being protected against; freeze accounts before it")
    already = run.frozen()
    before, r1 = compute_capacity(run, run.active, [e for e in entries if e not in already],
                                  [h for h in hubs if h not in already])
    removed = sorted(already | set(freeze))
    live_entries = [e for e in entries if e not in removed]
    with run.db.fork(removed) as fork:
        after, r2 = compute_capacity(run, fork, live_entries, hubs)
        routes = []
        for e in live_entries:
            for h in hubs:
                for row in fork.ro("money_trail_paths", {"src": e, "dst": h, "max_len": 8, "path_count": 2}):
                    if row["nodes"] not in routes:
                        routes.append(row["nodes"])
    pct = round(100 * after.value / before.value, 1) if before.value else 0.0
    data = {
        "freeze": freeze, "entry_ids": entries, "hub_ids": hubs,
        "capacity_before": before.value, "capacity_after": after.value, "remaining_pct": pct,
        "residual_routes": sorted(routes, key=len)[:5], "engine": after.engine,
        "method": "graph copied (GRAPH.COPY), accounts deleted from the copy, algorithms re-run, copy dropped",
    }
    data["evidence_id"] = run.evidence.add(
        "simulation", "simulate_freeze", freeze + entries + hubs + [n for r in routes for n in r], [],
        {"freeze": freeze, "capacity_before": before.value, "capacity_after": after.value,
         "remaining_pct": pct, "residual_routes": sorted(routes, key=len)[:5], "engine": after.engine},
        r1 + r2 + [Receipt("fork_remove_accounts", {"ids": removed})])
    return data


def plan_minimum_freeze(run: Run, entry_ids: list[str], hub_ids: list[str], max_accounts: int = 10) -> dict:
    """The fewest, least-collateral accounts whose freeze cuts *every* route from the
    entry accounts to the hubs - then proven inside FalkorDB on a fork of the graph."""
    entries, hubs = _endpoints(run, entry_ids, hub_ids)
    frozen = run.frozen()
    entries = [e for e in entries if e not in frozen]
    if not entries:
        raise ToolError("every entry account is already frozen")
    edges, edge_receipt = _flow_edges(run.active)
    base = max_flow(edges, entries, hubs)
    if base.value <= 0:
        eid = run.evidence.add("freeze_plan", "plan_minimum_freeze", entries + hubs, [],
                               {"capacity_before": 0.0, "recommended": [], "note": "no money path"},
                               [edge_receipt])
        return {"recommended": [], "capacity_before": 0.0, "evidence_id": eid,
                "note": "no money can currently move from these entries to these hubs"}
    network = set(entries) | set(hubs) | {n for u, v, *_ in base.edge_flows for n in (u, v)}
    vols = run.live.ro("counterparty_volumes", {"ids": sorted(network)})
    total: dict[str, float] = defaultdict(float)
    outside: dict[str, float] = defaultdict(float)
    for r in vols:
        total[r["account"]] += r["volume"]
        if r["counterparty"] not in network:
            outside[r["account"]] += r["volume"]
    cost = {n: 1.0 + (outside[n] / total[n] if total[n] else 0.0) for n in network}
    cut = min_vertex_cut(edges, entries, hubs, cost)
    if not cut.feasible:
        raise ToolError("an entry account pays a hub directly; freeze the entry account itself")

    # Proof: delete the recommended accounts from a copy of the graph and re-run.
    removed = sorted(frozen | set(cut.accounts))
    with run.db.fork(removed) as fork:
        after, cap_receipts = compute_capacity(run, fork, [e for e in entries if e not in removed], hubs)
        remaining_paths = 0
        for e in entries:
            if e in removed:
                continue
            for h in hubs:
                remaining_paths += len(fork.ro("money_trail_paths",
                                               {"src": e, "dst": h, "max_len": 8, "path_count": 1}))

    def alternative(label: str, accounts: list[str]) -> dict:
        res = max_flow(edges, entries, hubs, set(accounts))
        route = _route_avoiding(edges, entries, hubs, set(accounts)) if res.value > 0 else None
        return {"plan": label, "accounts": accounts, "count": len(accounts), "capacity_after": res.value,
                "remaining_pct": round(100 * res.value / base.value, 1), "residual_route": route}

    carried: dict[str, float] = defaultdict(float)
    for u, v, f, _c in base.edge_flows:
        if v not in hubs:
            carried[v] += f
    biggest = max(carried, key=lambda n: (carried[n], n)) if carried else None
    carriers = sorted(n for n in network if n not in hubs)
    alternatives = [alternative("freeze the alerted account only", [entries[0]])]
    if biggest and biggest != entries[0]:
        alternatives.append(alternative(f"freeze the biggest aggregator ({biggest})", [biggest]))
    alternatives.append(alternative("freeze every account on the money paths", carriers))
    recommended = {
        "plan": "minimum cut", "accounts": cut.accounts, "count": len(cut.accounts),
        "collateral_cost": round(cut.cost, 3), "capacity_before": base.value,
        "capacity_after": after.value, "remaining_paths": remaining_paths,
        "verified_on": "fork of the live graph (GRAPH.COPY)", "engine": after.engine,
        "why": [f"{a}: every remaining route passes through it; "
                f"{round(100 * (cost[a] - 1))}% of its money is with accounts outside this network"
                for a in cut.accounts],
    }
    data = {
        "entry_ids": entries, "hub_ids": hubs, "recommended": recommended,
        "within_limit": len(cut.accounts) <= max_accounts, "alternatives": alternatives,
        "cost_model": "freezing an account costs 1 + the share of its money exchanged with "
                      "accounts outside this network (freezing busy legitimate accounts is costly)",
    }
    data["evidence_id"] = run.evidence.add(
        "freeze_plan", "plan_minimum_freeze", cut.accounts + entries + hubs, [],
        {"recommended": cut.accounts, "count": len(cut.accounts), "capacity_before": base.value,
         "capacity_after": after.value, "remaining_paths": remaining_paths,
         "entry_ids": entries, "hub_ids": hubs,
         "alternatives": [{"plan": a["plan"], "count": a["count"], "remaining_pct": a["remaining_pct"]}
                          for a in alternatives]},
        [edge_receipt, Receipt("counterparty_volumes", {"ids": sorted(network)}),
         Receipt("fork_remove_accounts", {"ids": removed}), *cap_receipts])
    return data


# ---------------------------------------------------------------------------
# registry (descriptions double as the model's tool documentation)
# ---------------------------------------------------------------------------
_ID = {"type": "string", "description": "Account id, e.g. A17"}
_IDS = {"type": "array", "items": {"type": "string"}, "minItems": 1}


@dataclass(frozen=True)
class ToolSpec:
    name: str
    fn: Callable[..., dict]
    description: str
    parameters: dict


TOOLS: dict[str, ToolSpec] = {t.name: t for t in [
    ToolSpec("search_accounts", search_accounts,
             "Find accounts by id prefix or owner name.",
             {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}),
    ToolSpec("account_profile", account_profile,
             "Owner, age, status, legacy anomaly score and rank, in/out totals, how many senders paid "
             "only once, and how fast money leaves the account.",
             {"type": "object", "properties": {"account_id": _ID}, "required": ["account_id"]}),
    ToolSpec("shared_infrastructure", shared_infrastructure,
             "Accounts that log in from the same devices or IP addresses as this account.",
             {"type": "object", "properties": {"account_id": _ID}, "required": ["account_id"]}),
    ToolSpec("detect_ring", detect_ring,
             "Groups accounts tied together by shared devices/IPs (graph WCC) and measures whether the "
             "group behaves like a mule ring (pass-through, forwarding speed). Returns entry points and "
             "cash-out candidates. Give it the seed account plus any linked accounts.",
             {"type": "object", "properties": {"account_ids": _IDS}, "required": ["account_ids"]}),
    ToolSpec("money_trail", money_trail,
             "Shortest money routes from src to dst (graph SPpaths), each checked for a time-ordered "
             "sequence of real transfers. quality: strong | weak | structural.",
             {"type": "object", "properties": {"src": _ID, "dst": _ID,
                                               "max_len": {"type": "integer", "minimum": 1, "maximum": 8},
                                               "path_count": {"type": "integer", "minimum": 1, "maximum": 8}},
              "required": ["src", "dst"]}),
    ToolSpec("follow_funds", follow_funds,
             "Follow one payment forward hop by hop: each next transfer must leave within the window "
             "and keep most of the amount. Starts from the account's largest outgoing transfer unless "
             "transfer_id is given. Best for complaints about a specific loss.",
             {"type": "object", "properties": {"account_id": _ID, "transfer_id": {"type": "string"},
                                               "window_minutes": {"type": "integer"},
                                               "min_retained": {"type": "number"},
                                               "max_hops": {"type": "integer"}},
              "required": ["account_id"]}),
    ToolSpec("rank_hubs", rank_hubs,
             "Top accounts by PageRank over transfers (collectors, sinks, busy merchants).",
             {"type": "object", "properties": {"limit": {"type": "integer", "minimum": 1, "maximum": 25}}}),
    ToolSpec("layering_scan", layering_scan,
             "Find pass-through patterns: money arriving at these accounts and leaving again within the "
             "window for a similar amount.",
             {"type": "object", "properties": {"account_ids": _IDS, "window_minutes": {"type": "integer"},
                                               "fee_tolerance": {"type": "number"}},
              "required": ["account_ids"]}),
    ToolSpec("laundering_capacity", laundering_capacity,
             "Maximum money that can flow from entry accounts to hub accounts (max-flow), with the "
             "bottleneck transfers. Frozen accounts are excluded.",
             {"type": "object", "properties": {"entry_ids": _IDS, "hub_ids": _IDS},
              "required": ["entry_ids", "hub_ids"]}),
    ToolSpec("simulate_freeze", simulate_freeze,
             "What-if: copy the graph, remove the given accounts, re-run capacity and routes. "
             "Shows what would still get through. Changes nothing.",
             {"type": "object", "properties": {"freeze_ids": _IDS, "entry_ids": _IDS, "hub_ids": _IDS},
              "required": ["freeze_ids", "entry_ids", "hub_ids"]}),
    ToolSpec("plan_minimum_freeze", plan_minimum_freeze,
             "Smallest, least-collateral set of accounts to freeze that cuts EVERY route from the entry "
             "accounts to the hubs (minimum cut), proven on a copy of the graph, compared with naive plans.",
             {"type": "object", "properties": {"entry_ids": _IDS, "hub_ids": _IDS,
                                               "max_accounts": {"type": "integer"}},
              "required": ["entry_ids", "hub_ids"]}),
]}


def openai_tool_specs() -> list[dict]:
    return [{"type": "function", "function": {"name": t.name, "description": t.description,
                                              "parameters": t.parameters}} for t in TOOLS.values()]


def call_tool(run: Run, name: str, args: dict) -> dict:
    """Execute a tool by name. Bad input becomes {"error": ...} the model can read and fix."""
    spec = TOOLS.get(name)
    if spec is None:
        return {"error": f"unknown tool '{name}'. Available: {', '.join(TOOLS)}"}
    allowed = set(spec.parameters.get("properties", {}))
    unknown = set(args) - allowed
    if unknown:
        return {"error": f"unexpected argument(s) {sorted(unknown)} for {name}"}
    try:
        return spec.fn(run, **args)
    except ToolError as exc:
        return {"error": str(exc)}
    except TypeError as exc:
        return {"error": f"bad arguments for {name}: {exc}"}
