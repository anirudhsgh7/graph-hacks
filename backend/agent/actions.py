"""Proposed actions are derived from evidence by the server, never written by the model.

Every proposal carries the evidence ids that justify it; one without evidence is
never produced. Freeze proposals carry a simulation computed on the graph. Nothing
changes in the graph until the analyst confirms (POST /api/actions/execute).
"""
from __future__ import annotations

import time
import uuid

from agent.evidence import EvidenceLog
from agent.tools import Run, compute_capacity
from graph.db import Database

ACTION_TYPES = ("freeze_accounts", "flag_accounts", "clear_alert", "export_case_report")


class ActionError(Exception):
    def __init__(self, code: str, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail or {}


def _new_id() -> str:
    return f"act-{uuid.uuid4().hex[:8]}"


def propose(run: Run, log: EvidenceLog, conclusion: str, findings: list[dict]) -> list[dict]:
    actions: list[dict] = []
    frozen = run.frozen()
    plan = next((e for e in reversed(log.of_type("freeze_plan")) if e.result_excerpt.get("recommended")), None)
    if plan:
        x = plan.result_excerpt
        todo = [a for a in x["recommended"] if a not in frozen]
        if todo:
            caps = [e.id for e in log.of_type("capacity")][-1:]
            actions.append({
                "id": _new_id(), "type": "freeze_accounts",
                "label": f"Freeze {len(todo)} account{'s' if len(todo) != 1 else ''} ({', '.join(todo)}) - cuts every route",
                "account_ids": todo, "requires_confirmation": True,
                "evidence_refs": [plan.id, *caps],
                "simulation": {"capacity_before": x["capacity_before"], "capacity_after": x["capacity_after"],
                               "residual_routes": [], "remaining_paths": x["remaining_paths"],
                               "verified_on": "fork"},
            })
    rings = [e for e in log.of_type("community") if e.result_excerpt.get("verdict") == "mule_ring"]
    for ring in rings:
        members = ring.node_ids[: ring.result_excerpt["community_size"]]
        planned = set(actions[0]["account_ids"]) if actions else set()
        to_flag = [m for m in members if m not in planned and m not in frozen]
        if to_flag:
            actions.append({
                "id": _new_id(), "type": "flag_accounts",
                "label": f"Flag and watchlist {len(to_flag)} ring account{'s' if len(to_flag) != 1 else ''}",
                "account_ids": to_flag, "requires_confirmation": True,
                "evidence_refs": [ring.id], "simulation": None,
            })
        cap = next((e for e in reversed(log.of_type("capacity"))), None)
        unfrozen = [m for m in members if m not in frozen]
        route_already_cut = cap is not None and not cap.result_excerpt["capacity"]
        # Without a minimum-cut plan, offer the blunt option - unless money can no longer move.
        if not plan and unfrozen and not route_already_cut:
            simulation = None
            if cap and cap.result_excerpt["capacity"]:
                before = cap.result_excerpt["capacity"]
                after, _ = compute_capacity(run, run.active, cap.result_excerpt["entry_ids"],
                                            cap.result_excerpt["hub_ids"], exclude=set(unfrozen))
                simulation = {"capacity_before": before, "capacity_after": after.value,
                              "residual_routes": [], "remaining_paths": None, "verified_on": "python"}
            actions.append({
                "id": _new_id(), "type": "freeze_accounts",
                "label": f"Freeze all {len(unfrozen)} ring accounts",
                "account_ids": unfrozen, "requires_confirmation": True,
                "evidence_refs": [ring.id] + ([cap.id] if cap else []), "simulation": simulation,
            })
    if conclusion == "no_evidence":
        refs = list(dict.fromkeys(r for f in findings for r in f["evidence_refs"]))
        if refs:
            actions.append({
                "id": _new_id(), "type": "clear_alert",
                "label": "Close the alert as explained - no laundering evidence",
                "account_ids": [], "requires_confirmation": True, "evidence_refs": refs, "simulation": None,
            })
    refs = list(dict.fromkeys(r for f in findings for r in f["evidence_refs"]))
    if refs:
        actions.append({
            "id": _new_id(), "type": "export_case_report", "label": "Export case report",
            "account_ids": [], "requires_confirmation": False, "evidence_refs": refs, "simulation": None,
        })
    return [a for a in actions if a["evidence_refs"]]


def execute(db: Database, action_id: str, case_id: str | None = None) -> dict:
    live = db.live()
    rows = live.ro("proposal_get", {"id": action_id})
    if not rows:
        raise ActionError("BAD_REQUEST", f"unknown action id {action_id}")
    p = rows[0]
    if case_id and p["case_id"] != case_id:
        raise ActionError("BAD_REQUEST", f"action {action_id} belongs to case {p['case_id']}")
    if p["status"] == "executed":
        raise ActionError("ACTION_CONFLICT", "this action has already been executed",
                          {"action_id": action_id})
    now = int(time.time() * 1000)
    affected: list[str] = []
    delta: dict = {"nodes": [], "case": None}
    if p["type"] == "freeze_accounts":
        affected = [r["id"] for r in live.rw("accounts_freeze", {"ids": p["account_ids"], "at": now})]
        if not affected:
            raise ActionError("ACTION_CONFLICT", "all of these accounts are already frozen",
                              {"account_ids": p["account_ids"]})
        db.invalidate_active()
        delta["nodes"] = [{"id": a, "status": "frozen"} for a in affected]
    elif p["type"] == "flag_accounts":
        affected = [r["id"] for r in live.rw("accounts_flag", {"ids": p["account_ids"]})]
        if not affected:
            raise ActionError("ACTION_CONFLICT", "these accounts are already flagged or frozen",
                              {"account_ids": p["account_ids"]})
        delta["nodes"] = [{"id": a, "status": "flagged"} for a in affected]
    elif p["type"] == "clear_alert":
        live.rw("case_set_status", {"id": p["case_id"], "status": "cleared"})
        delta["case"] = {"id": p["case_id"], "status": "cleared"}
    elif p["type"] != "export_case_report":
        raise ActionError("BAD_REQUEST", f"unsupported action type {p['type']}")
    audit_id = f"aud-{uuid.uuid4().hex[:8]}"
    live.rw("action_create", {"case_id": p["case_id"], "id": audit_id, "type": p["type"], "label": p["label"],
                              "created_at": now, "account_ids": p["account_ids"],
                              "evidence_refs": p["evidence_refs"], "proposal_id": action_id,
                              "affected": affected})
    live.rw("proposal_mark_executed", {"id": action_id, "at": now})
    result = {"action_id": action_id, "type": p["type"], "status": "executed", "affected": affected,
              "graph_delta": delta, "audit_id": audit_id}
    if p["type"] == "export_case_report":
        result["report_url"] = f"/api/cases/{p['case_id']}/report"
    return result
