"""What the model sees of each tool result: just enough to choose the next tool.

The full tool output still becomes evidence (agent/evidence.py) and drives the verdict,
the findings and the UI; the model only needs ids, a few numbers and the evidence id to
cite. Sending digests instead of raw JSON cuts an investigation from ~17K to a few
thousand input tokens, which is what lets it fit free-tier per-minute limits (Groq: 8K).
"""
from __future__ import annotations

import json
from typing import Any, Callable

MAX_LIST = 6


def _ids(items: list[dict] | None, key: str = "account", n: int = MAX_LIST) -> list[str]:
    return [i[key] for i in (items or [])[:n] if isinstance(i, dict) and key in i]


def _profile(o: dict) -> dict:
    return {
        "account": o["account"], "type": o["type"], "status": o["status"], "age_days": o["account_age_days"],
        "anomaly_rank": f"{o['anomaly_rank']} of {o['accounts_ranked']}",
        "senders": o["inbound"]["distinct_senders"], "one_time_sender_share": o["inbound"]["one_time_sender_share"],
        "recipients": o["outbound"]["distinct_recipients"],
        "forwarded_within_60_min_share": o["forwarded_within_60_min_share"],
        "median_minutes_money_stays": o["median_minutes_money_stays"],
        "same_owner": o["other_accounts_same_owner"][:MAX_LIST],
    }


def _shared(o: dict) -> dict:
    return {"linked_accounts": _ids(o["linked_accounts"], n=12), "devices": o["shared_devices"][:MAX_LIST],
            "ips": o["shared_ips"][:MAX_LIST]}


def _ring(o: dict) -> dict:
    groups = []
    for g in o.get("groups", [])[:3]:
        groups.append({
            "members": g["members"][:12], "verdict": g["verdict"],
            "pass_through": g["signals"]["pass_through_ratio"],
            "median_forward_minutes": g["signals"]["median_forward_minutes"],
            "devices": len(g["shared_devices"]), "ips": len(g["shared_ips"]),
            "entry_points": _ids(g["entry_points"]), "cashout_candidates": _ids(g["cashout_candidates"], n=3),
            "evidence_id": g["evidence_id"],
        })
    out: dict[str, Any] = {"verdict": o["verdict"], "groups": groups}
    if o.get("unlinked_accounts"):
        out["unlinked"] = o["unlinked_accounts"][:MAX_LIST]
    return out


def _trail(o: dict) -> dict:
    paths = []
    for p in o.get("paths", [])[:4]:
        d = {"nodes": p["nodes"], "quality": p["quality"], "evidence_id": p["evidence_id"]}
        for k in ("minutes_total", "start_amount", "end_amount"):
            if k in p:
                d[k] = p[k]
        paths.append(d)
    return {"paths": paths, "strong_paths": o.get("strong_paths", 0), "frozen_excluded": o.get("frozen_excluded", [])}


def _funds(o: dict) -> dict:
    return {"path": [o["start_account"]] + [h["to"] for h in o["hops"]], "minutes_total": o["minutes_total"],
            "start_amount": o["start_amount"], "end_amount": o["end_amount"], "fee_per_hop_pct": o["fee_per_hop_pct"],
            "end_account_type": o["end_account_type"], "stopped_because": o["stopped_because"]}


def _capacity(o: dict) -> dict:
    return {"capacity": o["capacity"], "bottlenecks": [[b["from"], b["to"], b["capacity"]] for b in o["bottlenecks"][:3]],
            "frozen_excluded": o["frozen_excluded"]}


def _simulate(o: dict) -> dict:
    return {"freeze": o["freeze"], "capacity_before": o["capacity_before"], "capacity_after": o["capacity_after"],
            "remaining_pct": o["remaining_pct"], "residual_route": (o["residual_routes"] or [None])[0]}


def _plan(o: dict) -> dict:
    r = o.get("recommended")
    if not r:
        return {"recommended": [], "note": o.get("note")}
    return {"recommended": r["accounts"], "capacity_before": r["capacity_before"], "capacity_after": r["capacity_after"],
            "remaining_paths": r["remaining_paths"],
            "alternatives": [{"plan": a["plan"], "remaining_pct": a["remaining_pct"]} for a in o["alternatives"]]}


def _layering(o: dict) -> dict:
    return {"pass_through_patterns": o["pass_through_patterns"], "per_account": o["per_account"]}


def _hubs(o: dict) -> dict:
    return {"top": [f"{r['account']} ({r['type']})" for r in o["ranking"][:8]]}


def _search(o: dict) -> dict:
    return {"matches": [f"{m['id']} ({m['type']}, {m['owner']})" for m in o["matches"][:8]]}


DIGESTS: dict[str, Callable[[dict], dict]] = {
    "account_profile": _profile, "shared_infrastructure": _shared, "detect_ring": _ring, "money_trail": _trail,
    "follow_funds": _funds, "laundering_capacity": _capacity, "simulate_freeze": _simulate,
    "plan_minimum_freeze": _plan, "layering_scan": _layering, "rank_hubs": _hubs, "search_accounts": _search,
}


def digest(name: str, out: dict) -> dict:
    if "error" in out:
        return {"error": out["error"]}
    fn = DIGESTS.get(name)
    try:
        d = fn(out) if fn else {"result": "ok"}
    except (KeyError, TypeError, IndexError):  # unexpected shape: the evidence still has everything
        d = {"result": "ok - details recorded as evidence"}
    if "evidence_id" in out and "evidence_id" not in d:
        d["evidence_id"] = out["evidence_id"]
    if out.get("note"):
        d["note"] = out["note"]
    return d


def evidence_ledger(evidence: list) -> list[dict]:
    """Compact list of every piece of evidence, for the final (narration) request."""
    ledger = []
    for e in evidence:
        facts = {k: (v[:8] if isinstance(v, list) else v) for k, v in e.result_excerpt.items() if k != "flow_pairs"}
        accounts = [n for n in e.node_ids if not n.startswith(("D-", "IP-"))][:10]
        ledger.append({"id": e.id, "type": e.type, "tool": e.tool, "accounts": accounts, "facts": facts})
    return ledger


def dumps(obj: Any) -> str:
    """Compact JSON (no spaces) - every character is a token cost on every later request."""
    return json.dumps(obj, default=str, separators=(",", ":"))
