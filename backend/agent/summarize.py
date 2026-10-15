"""Deterministic verdict and findings, computed from evidence alone.

The verdict is a rule over graph measurements, not something the model decides:
  suspicious   - a mule ring was measured, or a payment was traced through >= 3
                 rapid, fee-skimming hops, or >= 5 pass-through transfers were found
  no_evidence  - the tools ran and none of that appeared
  inconclusive - too little was examined to say

These findings are used when no LLM is configured, when the LLM fails, and when the
LLM's own conclusion disagrees with the rule (the model narrates; it cannot talk its
way into or out of a verdict).
"""
from __future__ import annotations

from agent.evidence import Evidence, EvidenceLog


def _usd(x: float) -> str:
    return f"${x:,.0f}"


def _n(count: int, word: str) -> str:
    """'1 device', '3 devices', '1 IP address', '2 IP addresses'."""
    plural = word + ("es" if word.endswith("s") else "s")
    return f"{count} {word if count == 1 else plural}"


def _pct(x: float) -> str:
    return f"{x:g}%"


def _join(items: list[str]) -> str:
    items = list(items)
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def verdict(log: EvidenceLog) -> str:
    rings = [e for e in log.of_type("community") if e.result_excerpt.get("verdict") == "mule_ring"]
    traced = [e for e in log.of_type("path") if e.tool == "follow_funds"
              and e.result_excerpt.get("hops", 0) >= 3 and e.result_excerpt.get("fee_per_hop_pct")]
    layering = [e for e in log.of_type("pattern") if e.result_excerpt.get("pass_through_patterns", 0) >= 5]
    if rings or traced or layering:
        return "suspicious"
    return "no_evidence" if len(log.all()) >= 3 else "inconclusive"


def _ring_finding(e: Evidence) -> dict:
    x = e.result_excerpt
    members = e.node_ids[: x["community_size"]]
    return {
        "title": f"Mule ring detected ({x['community_size']} accounts)",
        "detail": (f"{_join(members)} share {_n(x['shared_devices'], 'device')} and {_n(x['shared_ips'], 'IP address')}, "
                   f"pass on {round(100 * x['pass_through_ratio'])}% of what they receive, typically "
                   f"{round(x['median_forward_minutes'])} minutes after it arrives."),
        "confidence": 0.9, "evidence_refs": [e.id],
    }


def _shared_only_finding(e: Evidence) -> dict:
    x = e.result_excerpt
    members = e.node_ids[: x["community_size"]]
    gap = x.get("median_forward_minutes")
    timing = (f"money stays about {round(gap / 60)} hours before moving on" if gap
              else "money is not passed on")
    return {
        "title": f"Shared devices, but not a mule ring ({x['community_size']} accounts)",
        "detail": (f"{_join(members)} share {_n(x['shared_devices'], 'device')} and {_n(x['shared_ips'], 'IP address')}, "
                   f"yet only {round(100 * x['pass_through_ratio'])}% of incoming money is passed on and {timing}. "
                   "That fits a household or small team, not a laundering ring."),
        "confidence": 0.8, "evidence_refs": [e.id],
    }


def _trail_finding(paths: list[Evidence]) -> dict | None:
    strong = [p for p in paths if p.tool == "money_trail" and p.result_excerpt.get("quality") == "strong"]
    if not strong:
        return None
    best = min(strong, key=lambda p: (p.result_excerpt["minutes_total"], p.result_excerpt["hops"]))
    x = best.result_excerpt
    src, dst = best.node_ids[0], best.node_ids[-1]
    others = len(strong) - 1
    return {
        "title": f"Money trail {src} to {dst}: {x['hops']} hops in {round(x['minutes_total'])} minutes",
        "detail": (f"{' -> '.join(best.node_ids)}: {_usd(x['start_amount'])} left {src} and {_usd(x['end_amount'])} "
                   f"reached {dst}; no hop took longer than {round(x['max_hop_minutes'])} minutes."
                   + (f" {_n(others, 'more time-ordered route')} lead{'s' if others == 1 else ''} to {dst}." if others else "")),
        "confidence": 0.9, "evidence_refs": [p.id for p in strong[:4]],
    }


def _funds_finding(e: Evidence) -> dict:
    x = e.result_excerpt
    if x["hops"] < 2:
        return {"title": f"Largest outgoing payment went to {x['end_account']} and stopped there",
                "detail": (f"{_usd(x['start_amount'])} from {e.node_ids[0]} to {x['end_account']}; it was not "
                           "passed on to anyone else within the hour."),
                "confidence": 0.75, "evidence_refs": [e.id]}
    fee = x.get("fee_per_hop_pct")
    detail = (f"{' -> '.join(e.node_ids)}: {_usd(x['start_amount'])} became {_usd(x['end_amount'])} in "
              f"{round(x['minutes_total'])} minutes")
    if fee:
        detail += f", {fee['min']:.1f}-{fee['max']:.1f}% skimmed at every hop - the pattern of a paid mule chain"
    return {
        "title": f"Funds traced from {e.node_ids[0]} to {x['end_account']} ({_n(x['hops'], 'hop')})",
        "detail": detail + ".", "confidence": 0.9 if x["hops"] >= 3 else 0.7, "evidence_refs": [e.id],
    }


def _capacity_finding(e: Evidence) -> dict | None:
    x = e.result_excerpt
    if not x["capacity"]:
        return {"title": "No money can currently reach the hub",
                "detail": f"Maximum flow from {_join(x['entry_ids'])} to {_join(x['hub_ids'])} is $0.",
                "confidence": 0.9, "evidence_refs": [e.id]}
    return {"title": f"Laundering capacity: {_usd(x['capacity'])}",
            "detail": (f"Maximum money that can flow from {_join(x['entry_ids'])} to {_join(x['hub_ids'])} "
                       "over the observed transfers (max-flow)."),
            "confidence": 0.85, "evidence_refs": [e.id]}


def _plan_finding(e: Evidence) -> dict | None:
    x = e.result_excerpt
    if not x.get("recommended"):
        return None
    alts = "; ".join(f"{a['plan']}: {_pct(a['remaining_pct'])} still flows" for a in x.get("alternatives", [])
                     if a["remaining_pct"] > 0)
    return {
        "title": f"Freezing {_n(len(x['recommended']), 'account')} stops every route: {_join(x['recommended'])}",
        "detail": (f"Minimum cut between {_join(x['entry_ids'])} and {_join(x['hub_ids'])}, proven on a copy of the "
                   f"graph: capacity {_usd(x['capacity_before'])} -> {_usd(x['capacity_after'])}, "
                   f"{_n(x['remaining_paths'], 'route')} left." + (f" Compare: {alts}." if alts else "")),
        "confidence": 0.95, "evidence_refs": [e.id],
    }


def _simulation_finding(e: Evidence) -> dict:
    x = e.result_excerpt
    route = x["residual_routes"][0] if x["residual_routes"] else None
    return {"title": f"What-if freeze of {_join(x['freeze'])}: {_pct(x['remaining_pct'])} still flows",
            "detail": (f"Capacity {_usd(x['capacity_before'])} -> {_usd(x['capacity_after'])}."
                       + (f" Money still gets through via {' -> '.join(route)}." if route else " No route remains.")),
            "confidence": 0.9, "evidence_refs": [e.id]}


def _profile_explanation(e: Evidence, log: EvidenceLog) -> dict | None:
    x = e.result_excerpt
    acc = e.node_ids[0]
    if x.get("anomaly_top_pct") is None or x["anomaly_top_pct"] > 5:
        return None   # nothing unusual about this account that needs explaining
    parts = [f"its legacy anomaly score ranks #{x['anomaly_rank']} (top {_pct(x['anomaly_top_pct'])})"]
    if x.get("one_time_sender_share") and x.get("distinct_senders", 0) >= 20:
        parts.append(f"{x['distinct_senders']} different senders, {round(100 * x['one_time_sender_share'])}% "
                     "of whom paid exactly once (ordinary customers)")
    if not x.get("forwarded_within_60_min_share"):
        parts.append("no incoming payment is passed on within an hour")
    if len(e.node_ids) > 1:
        parts.append(f"outgoing settlements go to {_join(e.node_ids[1:])}, held by the same customer")
    return {"title": f"{acc}: high score, explained by ordinary activity",
            "detail": f"{acc} is a {x.get('type', 'regular')} account: " + "; ".join(parts) + ".",
            "confidence": 0.8, "evidence_refs": [e.id]}


def findings(log: EvidenceLog, conclusion: str) -> list[dict]:
    out: list[dict] = []
    for e in log.of_type("community"):
        v = e.result_excerpt.get("verdict")
        if v == "mule_ring":
            out.append(_ring_finding(e))
        elif v == "shared_infrastructure_only":
            out.append(_shared_only_finding(e))
        elif v == "no_ring" and conclusion != "suspicious":
            out.append({"title": "No shared devices or IP addresses",
                        "detail": (f"{_join(e.node_ids)} {'shares' if len(e.node_ids) == 1 else 'share'} "
                                   "no login infrastructure with any other account."),
                        "confidence": 0.75, "evidence_refs": [e.id]})
    trail = _trail_finding(log.of_type("path"))
    if trail:
        out.append(trail)
    for e in log.of_type("path"):
        if e.tool == "follow_funds" and (e.result_excerpt["hops"] >= 2 or conclusion != "suspicious"):
            out.append(_funds_finding(e))
    for e in log.of_type("no_path"):
        x = e.result_excerpt
        out.append({"title": f"No route from {x['src']} to {x['dst']}",
                    "detail": (f"No chain of transfers within {x['max_len']} hops"
                               + (f" once {_join(x['frozen_excluded'])} are frozen" if x.get("frozen_excluded") else "")
                               + "."), "confidence": 0.85, "evidence_refs": [e.id]})
    caps = log.of_type("capacity")
    if caps:
        f = _capacity_finding(caps[-1])
        if f:
            out.append(f)
    for e in log.of_type("freeze_plan"):
        f = _plan_finding(e)
        if f:
            out.append(f)
    for e in log.of_type("simulation"):
        out.append(_simulation_finding(e))
    for e in log.of_type("pattern"):
        n = e.result_excerpt["pass_through_patterns"]
        if n == 0 and conclusion != "suspicious":
            out.append({"title": "No pass-through activity",
                        "detail": (f"No payment entered and left {_join(e.node_ids)} within "
                                   f"{e.result_excerpt['window_minutes']} minutes for a similar amount."),
                        "confidence": 0.8, "evidence_refs": [e.id]})
        elif n >= 5 and not any(x.get("verdict") == "mule_ring" for x in
                                (c.result_excerpt for c in log.of_type("community"))):
            out.append({"title": f"{n} pass-through transfers",
                        "detail": "Money entered and left these accounts within the hour for similar amounts.",
                        "confidence": 0.75, "evidence_refs": [e.id]})
    if conclusion == "no_evidence":
        for e in log.of_type("profile")[:1]:
            f = _profile_explanation(e, log)
            if f:
                out.insert(0, f)
    return out[:6]


def summary(log: EvidenceLog, conclusion: str, found: list[dict], seed: str | None) -> str:
    who = seed or "these accounts"
    if conclusion == "inconclusive":
        return f"Not enough was examined to reach a conclusion about {who}."
    if conclusion == "no_evidence":
        return _no_evidence_summary(log, who)
    parts: list[str] = []
    ring = next((e for e in log.of_type("community") if e.result_excerpt.get("verdict") == "mule_ring"), None)
    if ring:
        x = ring.result_excerpt
        members = ring.node_ids[: x["community_size"]]
        if seed in members:
            parts.append(f"{who} is part of a {x['community_size']}-account mule ring that shares "
                         f"{_n(x['shared_devices'], 'device')} and passes money on within about "
                         f"{round(x['median_forward_minutes'])} minutes")
        else:
            parts.append(f"a {x['community_size']}-account mule ring ({_join(members)}) shares "
                         f"{_n(x['shared_devices'], 'device')} and passes money on within about "
                         f"{round(x['median_forward_minutes'])} minutes")
    funds = next((e for e in log.of_type("path") if e.tool == "follow_funds" and e.result_excerpt["hops"] >= 2), None)
    if funds:
        x = funds.result_excerpt
        middle = funds.node_ids[1:-1]
        parts.append(f"the {_usd(x['start_amount'])} from {funds.node_ids[0]} was passed through "
                     f"{_join(middle)} to {x['end_account']} in {round(x['minutes_total'])} minutes")
    strong = [p for p in log.of_type("path") if p.tool == "money_trail" and p.result_excerpt.get("quality") == "strong"]
    if strong and not funds:
        fastest = min(p.result_excerpt["minutes_total"] for p in strong)
        parts.append(f"money reaches {strong[0].node_ids[-1]} through {_n(len(strong), 'time-ordered route')}, "
                     f"the fastest in {round(fastest)} minutes")
    caps = log.of_type("capacity")
    if caps and caps[-1].result_excerpt["capacity"]:
        parts.append(f"up to {_usd(caps[-1].result_excerpt['capacity'])} can reach "
                     f"{_join(caps[-1].result_excerpt['hub_ids'])}")
    plan = next((e for e in log.of_type("freeze_plan") if e.result_excerpt.get("recommended")), None)
    if plan:
        x = plan.result_excerpt
        worst = max((a for a in x.get("alternatives", [])), key=lambda a: a["remaining_pct"], default=None)
        line = (f"freezing just {_join(x['recommended'])} cuts every route (proven on a copy of the graph)")
        if worst and worst["remaining_pct"] > 0:
            line += f", whereas '{worst['plan']}' would leave {_pct(worst['remaining_pct'])} flowing"
        parts.append(line)
    elif any(e.result_excerpt.get("capacity") == 0 for e in caps) or log.of_type("no_path"):
        parts.append("with the current freezes in place, no route to the cash-out remains")
    if not parts:
        return f"Suspicious activity around {who}: see findings."
    text = "; ".join(parts)
    return text[0].upper() + text[1:] + "."


def _no_evidence_summary(log: EvidenceLog, who: str) -> str:
    reasons: list[str] = []
    prof = next(iter(log.of_type("profile")), None)
    if prof:
        x = prof.result_excerpt
        if x.get("anomaly_top_pct") is not None and x["anomaly_top_pct"] <= 5:
            why = (f"{x['distinct_senders']} customers who each paid once"
                   if x.get("one_time_sender_share") == 1.0 and x.get("distinct_senders", 0) >= 20
                   else "ordinary activity")
            reasons.append(f"its top-{_pct(x['anomaly_top_pct'])} legacy score comes from {why}")
    for e in log.of_type("community"):
        x = e.result_excerpt
        if x.get("verdict") == "no_ring":
            reasons.append("it shares no devices or IP addresses with other accounts")
        elif x.get("verdict") == "shared_infrastructure_only":
            reasons.append(f"the {x['community_size']} accounts on the shared device pass on only "
                           f"{round(100 * x['pass_through_ratio'])}% of what they receive")
    if any(e.result_excerpt.get("pass_through_patterns") == 0 for e in log.of_type("pattern")):
        reasons.append("no money passes through within the hour")
    text = f"No evidence that {who} is laundering money"
    if reasons:
        text += ": " + _join(reasons)
    return text + "."
