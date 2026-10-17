"""The LLM tool loop against a scripted OpenAI-compatible server (no real key needed)."""
from __future__ import annotations

import json

from tests import fake_llm
from tests.conftest import PORT
from tests.fake_llm import reply_text, reply_tools, tool_call


def _with_fallback():
    from app.config import settings
    object.__setattr__(settings, "llm_fallback_api_key", "alt-key")
    object.__setattr__(settings, "llm_fallback_base_url", f"http://127.0.0.1:{PORT}/alt/v1")
    object.__setattr__(settings, "llm_fallback_model", "fake-fallback")


RING_SCRIPT = [
    reply_tools(tool_call("c1", "account_profile", {"account_id": "A17"}),
                tool_call("c2", "shared_infrastructure", {"account_id": "A17"})),        # ev-1, ev-2
    reply_tools(tool_call("c3", "detect_ring", {"account_ids": ["A17", "A22", "A31", "A47", "A63"]})),  # ev-3
    reply_tools(tool_call("c4", "laundering_capacity", {"entry_ids": ["A17", "A63", "A68"], "hub_ids": ["H3"]}),
                tool_call("c5", "plan_minimum_freeze", {"entry_ids": ["A17", "A63", "A68"], "hub_ids": ["H3"]})),
]                                                                                         # ev-4, ev-5


def _investigate(question="Who is behind this burst?", case_id="case-001"):
    from agent.loop import investigate
    from graph.db import db
    return investigate(db, question, case_id)


def test_llm_happy_path_and_evidence_validation(llm):
    final = {"conclusion": "suspicious", "summary": "A17 runs a mule ring; freezing A47 and A52 stops it.",
             "findings": [
                 {"title": "Ring", "detail": "7 accounts", "confidence": 0.9, "evidence_refs": ["ev-3"]},
                 {"title": "Plan", "detail": "2 freezes", "confidence": 1.4, "evidence_refs": ["ev-5", "ev-99"]},
                 {"title": "Invented", "detail": "no basis", "confidence": 0.9, "evidence_refs": ["ev-99"]}]}
    llm.SCRIPT.extend(RING_SCRIPT + [reply_tools(), reply_text("```json\n" + json.dumps(final) + "\n```")])
    llm.SCRIPT[3] = reply_text("I have enough.")   # turn without tool calls ends the loop
    p = _investigate()
    assert p["meta"]["mode"] == "llm" and p["meta"]["narrative_source"] == "llm"
    assert [f["title"] for f in p["findings"]] == ["Ring", "Plan"]          # invented finding dropped
    assert p["findings"][1]["evidence_refs"] == ["ev-5"]                     # bogus ref stripped
    assert p["findings"][1]["confidence"] == 1.0                             # clamped
    assert p["proposed_actions"][0]["account_ids"] == ["A47", "A52"]        # actions come from evidence
    # the loop echoed tool calls back correctly and asked for the final answer without tools
    second = llm.REQUESTS[1]["messages"]
    assert second[2]["role"] == "assistant" and second[2]["tool_calls"][0]["id"] == "c1"
    assert {m["tool_call_id"] for m in second if m["role"] == "tool"} == {"c1", "c2"}
    # the narration request is small: no tool schemas, no tool transcript, just the evidence ledger
    final = llm.REQUESTS[-1]
    assert "tools" not in final and all(m["role"] in ("system", "user") for m in final["messages"])
    assert '"id":"ev-3"' in final["messages"][1]["content"]
    # tool results reach the model as digests, not raw tool JSON
    tool_msgs = [json.loads(m["content"]) for m in llm.REQUESTS[2]["messages"] if m["role"] == "tool"]
    ring = next(m for m in tool_msgs if "groups" in m)
    assert ring["groups"][0]["entry_points"] == ["A17", "A63", "A68"] and "exit_points" not in ring["groups"][0]


def test_model_cannot_override_the_graph_verdict(llm):
    wrong = {"conclusion": "no_evidence", "summary": "Nothing here.",
             "findings": [{"title": "Fine", "detail": "", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend(RING_SCRIPT + [reply_text("done"), reply_text(json.dumps(wrong))])
    p = _investigate()
    assert p["conclusion"] == "suspicious" and p["meta"]["narrative_source"] == "deterministic"
    assert any("graph rule says 'suspicious'" in n for n in p["meta"]["notes"])


def test_provider_down_falls_back_to_rule_based(llm):
    llm.SCRIPT.append({"status": 503})
    p = _investigate()
    assert p["meta"]["mode"] == "rule_based" and p["conclusion"] == "suspicious"
    assert any(n.startswith("LLM_UNAVAILABLE") for n in p["meta"]["notes"])


def test_rate_limited_is_reported(llm):
    llm.SCRIPT.append({"status": 429})
    p = _investigate()
    assert any(n.startswith("LLM_RATE_LIMITED") for n in p["meta"]["notes"])


def test_rate_limit_mid_loop_runs_the_full_planner(llm):
    """A model run cut short (e.g. 429 after 2 tool calls) must not ship partial findings."""
    llm.SCRIPT.extend([RING_SCRIPT[0], {"status": 429}])
    p = _investigate()
    assert p["meta"]["mode"] == "rule_based" and p["meta"]["narrative_source"] == "deterministic"
    assert any(n.startswith("LLM_RATE_LIMITED") for n in p["meta"]["notes"])
    assert p["conclusion"] == "suspicious"
    assert len(p["findings"]) == 4              # the full deterministic investigation ran
    assert len(p["trace"]) >= 5                 # planner steps, not the two the model managed


def test_invalid_final_answer_twice_uses_deterministic_summary(llm):
    llm.SCRIPT.extend(RING_SCRIPT + [reply_text("done"), reply_text("not json"), reply_text("{still not")])
    p = _investigate()
    assert p["meta"]["mode"] == "llm" and p["meta"]["narrative_source"] == "deterministic"
    assert p["findings"] and p["conclusion"] == "suspicious"


def test_model_that_skips_tools_triggers_planner(llm):
    llm.SCRIPT.append(reply_text("A17 is obviously fine."))
    p = _investigate()
    assert p["meta"]["mode"] == "rule_based" and len(p["trace"]) >= 5


def test_bad_tool_arguments_are_returned_to_the_model(llm):
    llm.SCRIPT.extend([
        reply_tools(tool_call("x1", "money_trail", {"src": "A17"}),                  # missing dst
                    tool_call("x2", "drop_database", {}),                            # unknown tool
                    tool_call("x3", "account_profile", {"account_id": "A17", "sql": "x"})),
        reply_tools(tool_call("x4", "account_profile", {"account_id": "M8"})),
        reply_text("done"),
        reply_text(json.dumps({"conclusion": "no_evidence", "summary": "x", "findings": []})),
    ])
    p = _investigate("Is M8 laundering money?", "case-003")
    tool_msgs = [json.loads(m["content"]) for m in fake_llm.REQUESTS[1]["messages"] if m["role"] == "tool"]
    assert all("error" in t for t in tool_msgs)
    assert [t["ok"] for t in p["trace"]][:3] == [False, False, False]


def test_rate_limited_primary_switches_to_fallback_provider(llm):
    _with_fallback()
    final = {"conclusion": "suspicious", "summary": "Ring found.",
             "findings": [{"title": "Ring", "detail": "7", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend([RING_SCRIPT[0], {"status": 429}])                 # primary dies after one turn
    llm.SCRIPT_ALT.extend(RING_SCRIPT[1:] + [reply_text("done"), reply_text(json.dumps(final))])
    p = _investigate()
    assert p["meta"]["mode"] == "llm" and p["meta"]["narrative_source"] == "llm"
    assert p["meta"]["model"] == "fake-fallback"
    assert any("switched to" in n and "fake-fallback" in n for n in p["meta"]["notes"])
    # the fallback received the primary's history, tool-call ids intact
    replayed = llm.REQUESTS_ALT[0]["messages"]
    assert replayed[2]["tool_calls"][0]["id"] == "c1"
    assert {m["tool_call_id"] for m in replayed if m["role"] == "tool"} == {"c1", "c2"}


def test_short_retry_after_is_waited_out(llm):
    from app.config import settings
    object.__setattr__(settings, "llm_max_wait_s", 5)
    final = {"conclusion": "suspicious", "summary": "Ring.",
             "findings": [{"title": "Ring", "detail": "", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend([RING_SCRIPT[0],
                       {"status": 429, "text": "Rate limit reached. Please try again in 0.6s."},  # Groq style
                       *RING_SCRIPT[1:], reply_text("done"), reply_text(json.dumps(final))])
    p = _investigate()
    assert p["meta"]["mode"] == "llm" and p["meta"]["narrative_source"] == "llm"
    assert any("waited 0.6s" in n for n in p["meta"]["notes"])


def test_long_retry_after_is_not_waited(llm):
    from app.config import settings
    object.__setattr__(settings, "llm_max_wait_s", 5)
    llm.SCRIPT.extend([{"status": 429, "headers": {"retry-after": "40"}}])
    p = _investigate()
    assert p["meta"]["mode"] == "rule_based" and p["meta"]["latency_ms"] < 20000
    assert not any("waited" in n for n in p["meta"]["notes"])


def test_missing_tool_call_ids_are_synthesised(llm):
    calls = [{"type": "function", "function": {"name": "account_profile", "arguments": {"account_id": "M8"}}}]
    llm.SCRIPT.extend([{"role": "assistant", "content": None, "tool_calls": calls}, reply_text("done"),
                       reply_text(json.dumps({"conclusion": "no_evidence", "summary": "x", "findings": []}))])
    _investigate("Is M8 laundering money?", "case-003")
    sent = llm.REQUESTS[1]["messages"]
    call_id = sent[2]["tool_calls"][0]["id"]
    assert call_id.startswith("call_") and sent[2]["tool_calls"][0]["function"]["arguments"] == '{"account_id": "M8"}'
    assert sent[3]["tool_call_id"] == call_id


def test_reasoning_effort_dropped_when_rejected(llm):
    from app.config import settings
    object.__setattr__(settings, "llm_reasoning_effort", "low")
    llm.SCRIPT.extend([{"status": 400, "text": "unknown parameter: reasoning_effort"}, reply_text("A17 is fine.")])
    _investigate()
    assert llm.REQUESTS[0]["reasoning_effort"] == "low" and "reasoning_effort" not in llm.REQUESTS[1]


def test_token_budget_of_a_full_investigation(llm):
    """Guards the free-tier fix: a complete 5-request ring investigation stays small.
    (~3.5 characters per token for this JSON; Groq's free tier allows 8K tokens/min.)"""
    final = {"conclusion": "suspicious", "summary": "Ring.",
             "findings": [{"title": "Ring", "detail": "", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend([RING_SCRIPT[0], RING_SCRIPT[1],
                       reply_tools(tool_call("t", "money_trail", {"src": "A17", "dst": "H3"}), *RING_SCRIPT[2]["tool_calls"]),
                       reply_text(json.dumps(final))])      # the last turn carries the answer
    p = _investigate()
    assert p["meta"]["narrative_source"] == "llm" and len(llm.REQUESTS) == 4
    chars = sum(len(json.dumps({"m": r["messages"], "t": r.get("tools")}, separators=(",", ":"))) for r in llm.REQUESTS)
    assert chars / 3.5 < 8000, f"~{chars / 3.5:.0f} input tokens"


def test_early_stop_is_nudged_once_for_the_freeze_plan(llm):
    """A confirmed mule ring without capacity/freeze-plan evidence gets exactly one
    forced turn to call the money tools before an early answer is accepted."""
    final = {"conclusion": "suspicious", "summary": "Ring found; plan attached.",
             "findings": [{"title": "Ring", "detail": "7 accounts", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend([
        RING_SCRIPT[0], RING_SCRIPT[1],                     # profile + shared, then ring (ev-3)
        reply_text("I already have enough."),               # early stop -> nudge
        reply_tools(tool_call("n1", "laundering_capacity",
                              {"entry_ids": ["A17", "A63", "A68"], "hub_ids": ["H3"]}),
                    tool_call("n2", "plan_minimum_freeze",
                              {"entry_ids": ["A17", "A63", "A68"], "hub_ids": ["H3"]})),
        reply_text(json.dumps(final)),
    ])
    p = _investigate()
    assert p["meta"]["mode"] == "llm" and p["meta"]["narrative_source"] == "llm"
    assert any("asked once" in n for n in p["meta"]["notes"])
    assert any(e["type"] == "freeze_plan" for e in p["evidence"])
    nudge = llm.REQUESTS[3]["messages"][-1]                 # request sent right after the early stop
    assert nudge["role"] == "user" and "freeze plan" in nudge["content"]


def test_turns_exhausted_without_the_plan_are_completed_by_the_planner(llm):
    """Wandering models: if the tool turns run out before the freeze plan, the planner
    fills the missing steps - a confirmed ring never ships without capacity + plan."""
    final = {"conclusion": "suspicious", "summary": "Ring and plan.",
             "findings": [{"title": "Ring", "detail": "7 accounts", "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    filler = reply_tools(tool_call("f1", "account_profile", {"account_id": "A17"}))  # cached repeat
    llm.SCRIPT.extend([RING_SCRIPT[0], RING_SCRIPT[1],
                       filler, filler, filler, filler,      # all 6 turns, never the money tools
                       reply_text(json.dumps(final))])
    p = _investigate()
    assert p["meta"]["mode"] == "llm"
    assert any("completed the missing steps" in n for n in p["meta"]["notes"])
    assert any(e["type"] == "freeze_plan" for e in p["evidence"])
    freeze = next(a for a in p["proposed_actions"] if a["type"] == "freeze_accounts")
    assert freeze["account_ids"] == ["A47", "A52"]
