"""One investigation, end to end.

    question + case
        -> LLM tool loop (Groq), or the rule-based planner if no key / provider down
        -> evidence (every tool result registers what it saw, with query receipts)
        -> verdict (deterministic rule over evidence)        agent/summarize.py
        -> findings + summary (model's, if valid and agrees; otherwise deterministic)
        -> proposed actions (server-derived, evidence-gated)  agent/actions.py
        -> subgraph for the canvas                            agent/graphview.py
        -> stored on the case in FalkorDB
"""
from __future__ import annotations

import json
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError

from agent import actions, graphview, planner, summarize
from agent.digest import digest, dumps, evidence_ledger
from agent.llm import ChatSession, LLMError
from agent.prompts import FINAL, NARRATOR, SYSTEM, case_context
from agent.tools import TOOLS, Run, call_tool, openai_tool_specs
from app.config import settings
from graph.db import Database
from graph.queries import cypher

log = logging.getLogger(__name__)

EventSink = Callable[[str, dict], None]
ACCOUNT_RE = re.compile(r"\b([ACHMX]\d{1,3})\b", re.IGNORECASE)


class InvestigationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code, self.message = code, message


# ---- model answer schema ---------------------------------------------------------
class _Finding(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    detail: str = Field(default="", max_length=1200)
    confidence: float = 0.7
    evidence_refs: list[str] = Field(default_factory=list)


class _Answer(BaseModel):
    conclusion: str
    summary: str = Field(min_length=1, max_length=2000)
    findings: list[_Finding] = Field(default_factory=list, max_length=8)


def _parse_answer(text: str) -> _Answer:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.MULTILINE).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in the reply")
    answer = _Answer.model_validate(json.loads(text[start:end + 1]))
    if answer.conclusion not in ("suspicious", "no_evidence", "inconclusive"):
        raise ValueError(f"invalid conclusion '{answer.conclusion}'")
    return answer


def _headline(name: str, out: dict) -> str:
    if "error" in out:
        return out["error"]
    if name == "detect_ring":
        if out.get("verdict") == "no_ring":
            return "no shared devices/IPs"
        g = out["groups"][0]
        return f"{g['size']} accounts - {g['verdict'].replace('_', ' ')}"
    if name == "money_trail":
        return f"{len(out['paths'])} route(s), {out.get('strong_paths', 0)} time-ordered" if out["paths"] else "no route"
    if name == "follow_funds":
        return f"{out['hop_count']} hop(s) to {out['end_account']} in {out['minutes_total']:.0f} min"
    if name == "laundering_capacity":
        return f"capacity ${out['capacity']:,.0f} ({out['engine']})"
    if name == "plan_minimum_freeze":
        r = out.get("recommended") or {}
        return f"freeze {', '.join(r.get('accounts', []))} -> ${r.get('capacity_after', 0):,.0f} left" if r else out.get("note", "")
    if name == "simulate_freeze":
        return f"{out['remaining_pct']}% still flows"
    if name == "account_profile":
        return f"anomaly rank #{out['anomaly_rank']} of {out['accounts_ranked']}"
    if name == "shared_infrastructure":
        return f"{len(out['linked_accounts'])} linked account(s)"
    if name == "layering_scan":
        return f"{out['pass_through_patterns']} pass-through transfer(s)"
    if name == "rank_hubs":
        return "top: " + ", ".join(r["account"] for r in out["ranking"][:3])
    if name == "search_accounts":
        return f"{len(out['matches'])} match(es)"
    return "ok"


def _rows(out: dict) -> int:
    for key in ("paths", "groups", "linked_accounts", "hops", "flows", "ranking", "examples", "matches",
                "alternatives"):
        if isinstance(out.get(key), list):
            return len(out[key])
    return 0 if "error" in out else 1


# ---- the investigation -----------------------------------------------------------
class _Session:
    def __init__(self, db: Database, on_event: EventSink | None) -> None:
        self.run = Run(db)
        self.trace: list[dict] = []
        self.calls = 0
        self.on_event = on_event or (lambda _t, _d: None)
        self.started = time.time()
        self.cache: dict[str, dict] = {}

    def over_budget(self) -> bool:
        return time.time() - self.started > settings.agent_budget_s

    def step(self, name: str, args: dict) -> dict:
        key = name + json.dumps(args, sort_keys=True, default=str)
        if key in self.cache:      # the model sometimes repeats a call; don't pay twice
            return dict(self.cache[key], note="repeated call - same result as before")
        if self.calls >= settings.agent_max_tool_calls:
            return {"error": "tool-call budget exhausted; write your conclusion"}
        self.calls += 1
        n = len(self.trace) + 1
        self.on_event("step", {"step": n, "tool": name, "args": args, "status": "started"})
        t0 = time.time()
        try:
            out = call_tool(self.run, name, args)
        except Exception as exc:  # database outage etc.: surface, don't crash the run
            log.exception("tool %s failed", name)
            out = {"error": f"{name} failed: {exc.__class__.__name__}"}
        ms = int((time.time() - t0) * 1000)
        evidence_ids = sorted({v for v in _walk(out, "evidence_id")}, key=lambda s: int(s.split("-")[1]))
        entry = {"step": n, "tool": name, "args": args, "ok": "error" not in out, "rows": _rows(out),
                 "duration_ms": ms, "headline": _headline(name, out), "evidence_ids": evidence_ids}
        if "error" in out:
            entry["error"] = out["error"]
        self.trace.append(entry)
        self.on_event("step", dict(entry, status="done"))
        self.cache[key] = out
        return out


def _walk(obj: Any, key: str):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key and isinstance(v, str):
                yield v
            else:
                yield from _walk(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, key)


def _llm_investigation(s: _Session, chat: ChatSession, question: str, context: str,
                       notes: list[str]) -> _Answer | None:
    """Tool selection by the model, then a separate, small narration request.

    Token budget matters (free tiers allow a few thousand tokens per minute), so the model
    sees digests of tool results (agent/digest.py), and the final request carries only the
    evidence ledger - not the whole conversation and not the tool schemas."""
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM.format(max_calls=settings.agent_max_tool_calls)},
        {"role": "user", "content": f"{context}\n\nQuestion: {question}"},
    ]
    specs = openai_tool_specs()
    for _turn in range(settings.agent_max_turns):
        if s.over_budget():
            notes.append("time budget reached during tool selection")
            break
        msg = chat.chat(messages, tools=specs)  # ids normalised: history is portable
        messages.append(msg)
        calls = msg.get("tool_calls") or []
        if not calls:
            # Best case: the model's last turn already is the answer (saves a whole request).
            if s.run.evidence.all():
                try:
                    return _parse_answer(msg.get("content") or "")
                except (ValueError, ValidationError, json.JSONDecodeError):
                    pass  # fall through to the dedicated narration request
            break
        for c in calls:
            name = c["function"]["name"]
            try:
                args = json.loads(c["function"].get("arguments") or "{}")
                out = s.step(name, args) if isinstance(args, dict) else {"error": "arguments must be an object"}
            except json.JSONDecodeError:
                out = {"error": "arguments were not valid JSON"}
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": dumps(digest(name, out))})
    if not s.run.evidence.all():
        return None
    final = [
        {"role": "system", "content": NARRATOR},
        {"role": "user", "content": f"{context}\n\nQuestion: {question}\n\nEvidence:\n"
                                    f"{dumps(evidence_ledger(s.run.evidence.all()))}\n\n{FINAL}"},
    ]
    for attempt in range(2):
        reply = chat.chat(final)
        try:
            return _parse_answer(reply.get("content") or "")
        except (ValueError, ValidationError, json.JSONDecodeError) as exc:
            if attempt == 0:
                final += [{"role": "assistant", "content": reply.get("content") or ""},
                          {"role": "user", "content": f"That was not valid ({exc}). Reply with the JSON object only."}]
            else:
                notes.append(f"model's final answer was invalid twice ({exc}); deterministic summary used")
    return None


def _validated_findings(answer: _Answer, s: _Session) -> list[dict]:
    out = []
    for f in answer.findings:
        refs = [r for r in dict.fromkeys(f.evidence_refs) if r in s.run.evidence]
        if refs:
            out.append({"title": f.title.strip(), "detail": f.detail.strip(),
                        "confidence": round(min(max(f.confidence, 0.0), 1.0), 2), "evidence_refs": refs})
    return out


def investigate(db: Database, question: str, case_id: str | None = None,
                on_event: EventSink | None = None) -> dict:
    question = (question or "").strip()
    if not question:
        raise InvestigationError("BAD_REQUEST", "question must not be empty")
    if len(question) > 1000:
        raise InvestigationError("BAD_REQUEST", "question is too long (max 1000 characters)")
    live = db.live()
    case = None
    if case_id:
        rows = live.ro("case_get", {"id": case_id})
        if not rows:
            raise InvestigationError("BAD_REQUEST", f"unknown case {case_id}")
        case = rows[0]
    s = _Session(db, on_event)
    notes: list[str] = []
    named = [m.upper() for m in ACCOUNT_RE.findall(question)]
    known = {r["id"] for r in live.ro("accounts_by_id", {"ids": named})} if named else set()
    seeds = [a for a in dict.fromkeys(named) if a in known] or list((case or {}).get("seed_accounts") or [])
    previous = live.ro("investigation_list", {"case_id": case_id}) if case_id else []
    context = case_context(case, sorted(s.run.frozen()), previous[0]["summary"] if previous else None)

    mode, answer, model = "rule_based", None, None
    llm_failed = False
    chat = ChatSession(deadline=s.started + settings.agent_budget_s, notes=notes)
    if chat.enabled:
        mode = "llm"
        try:
            answer = _llm_investigation(s, chat, question, context, notes)
        except LLMError as exc:
            notes.append(f"{exc.code}: {exc}")
            log.warning("LLM failed: %s", exc)
            llm_failed = True
        model = chat.model
        if llm_failed or not s.run.evidence.all():
            # Never ship a half-finished model run (rate limits, outages): fall back to the
            # full deterministic investigation instead of accepting partial evidence.
            mode = "rule_based"
            notes.append(("the model run failed before finishing" if llm_failed else
                          "the model gathered no evidence") + "; the rule-based investigator ran instead")
    if not s.run.evidence.all() and not seeds:
        raise InvestigationError("BAD_REQUEST", "name an account (e.g. A17) or open a case to investigate")
    if (llm_failed or not s.run.evidence.all()) and seeds:
        planner.investigate(s.run, seeds[0], s.step)

    conclusion = summarize.verdict(s.run.evidence)
    narrative = "deterministic"
    findings = summarize.findings(s.run.evidence, conclusion)
    summary_text = summarize.summary(s.run.evidence, conclusion, findings, seeds[0] if seeds else None)
    if answer is not None:
        if answer.conclusion != conclusion:
            notes.append(f"model concluded '{answer.conclusion}' but the graph rule says '{conclusion}'; "
                         "deterministic findings used")
        else:
            checked = _validated_findings(answer, s)
            if checked:
                findings, summary_text, narrative = checked, answer.summary.strip(), "llm"
            else:
                notes.append("none of the model's findings cited valid evidence; deterministic findings used")
    for i, f in enumerate(findings, start=1):
        f["id"] = f"f-{i}"
        findings[i - 1] = {"id": f["id"], "title": f["title"], "detail": f["detail"],
                           "confidence": f["confidence"], "evidence_refs": f["evidence_refs"]}
        on_event and on_event("finding", {"id": f["id"], "title": f["title"]})

    proposed = actions.propose(s.run, s.run.evidence, conclusion, findings)
    graph = graphview.build(live, s.run.evidence, seeds[:1])
    caps = db.capabilities()
    status = "partial" if s.over_budget() and conclusion == "inconclusive" else \
        ("no_evidence" if conclusion == "no_evidence" else "complete")
    evidence = []
    for e in s.run.evidence.all():
        d = e.to_dict()
        d["receipts"] = [dict(r, cypher=cypher(r["query"])) for r in d["receipts"]]
        evidence.append(d)
    inv_id = f"inv-{uuid.uuid4().hex[:8]}"
    payload = {
        "investigation_id": inv_id, "case_id": case_id, "question": question,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status, "conclusion": conclusion, "summary": summary_text,
        "findings": findings, "evidence": evidence, "proposed_actions": proposed,
        "trace": s.trace, "graph": graph,
        "meta": {"mode": mode, "model": model, "narrative_source": narrative,
                 "tool_iterations": len(s.trace), "latency_ms": int((time.time() - s.started) * 1000),
                 "maxflow_engine": "falkordb" if caps.get("maxflow") else "python",
                 "frozen_accounts": sorted(s.run.frozen()), "notes": notes},
    }
    if case_id:
        live.rw("investigation_create", {"case_id": case_id, "id": inv_id, "question": question,
                                         "created_at": int(time.time() * 1000), "conclusion": conclusion,
                                         "mode": mode, "summary": summary_text,
                                         "payload": json.dumps(payload, default=str)})
        for a in proposed:
            live.rw("proposal_create", {"investigation_id": inv_id, "id": a["id"], "case_id": case_id,
                                        "type": a["type"], "label": a["label"], "account_ids": a["account_ids"],
                                        "evidence_refs": a["evidence_refs"]})
    return payload


def available_tools() -> list[str]:
    return list(TOOLS)
