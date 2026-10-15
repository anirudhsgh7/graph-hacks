"""Rule-based investigator: the same tools, chosen by fixed rules instead of a model.

Used when no LLM key is configured, when the provider is down or rate-limited, or
when the model returns without gathering any evidence. The demo therefore never
depends on a third-party API being up.
"""
from __future__ import annotations

from typing import Callable

from agent.tools import Run

Step = Callable[[str, dict], dict]   # (tool name, args) -> tool output


def investigate(run: Run, seed: str, step: Step) -> None:
    profile = step("account_profile", {"account_id": seed})
    if "error" in profile:
        return
    shared = step("shared_infrastructure", {"account_id": seed})
    linked = [x["account"] for x in shared.get("linked_accounts", [])]
    ring = step("detect_ring", {"account_ids": [seed, *linked]})
    mule = next((g for g in ring.get("groups", []) if g["verdict"] == "mule_ring"), None)

    if mule:
        members = mule["members"]
        step("layering_scan", {"account_ids": members})
        hub = next((c["account"] for c in mule["cashout_candidates"] if c["account"] not in members), None)
        entries = [e["account"] for e in mule["entry_points"]] or [seed]
        if hub:
            if seed != hub:
                step("money_trail", {"src": seed, "dst": hub})
            step("laundering_capacity", {"entry_ids": entries, "hub_ids": [hub]})
            step("plan_minimum_freeze", {"entry_ids": entries, "hub_ids": [hub]})
        return

    funds = step("follow_funds", {"account_id": seed})
    hops = funds.get("hops", [])
    if len(hops) >= 3:
        intermediates = [h["to"] for h in hops[:-1]]
        end = funds["end_account"]
        chain_ring = step("detect_ring", {"account_ids": intermediates})
        group = next((g for g in chain_ring.get("groups", []) if g["verdict"] == "mule_ring"), None)
        entries = [e["account"] for e in group["entry_points"]] if group else intermediates[:1]
        entries = [e for e in entries if e != end] or intermediates[:1]
        step("laundering_capacity", {"entry_ids": entries, "hub_ids": [end]})
        step("plan_minimum_freeze", {"entry_ids": entries, "hub_ids": [end]})
        return

    others = [g["members"] for g in ring.get("groups", [])]
    step("layering_scan", {"account_ids": others[0] if others else [seed]})
