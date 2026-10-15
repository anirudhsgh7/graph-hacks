"""The LLM tool loop against a scripted OpenAI-compatible server (no real key needed)."""
from __future__ import annotations

import json

import pytest

from tests import fake_llm
from tests.fake_llm import reply_text, reply_tools, tool_call

PORT = 8765


@pytest.fixture(scope="module")
def llm_server():
    server = fake_llm.serve(PORT)
    yield
    server.should_exit = True


@pytest.fixture()
def llm(llm_server, fresh):
    """Point the agent at the fake server for one test."""
    from app.config import settings
    saved = (settings.llm_api_key, settings.llm_base_url, settings.llm_model)
    object.__setattr__(settings, "llm_api_key", "test-key")
    object.__setattr__(settings, "llm_base_url", f"http://127.0.0.1:{PORT}/v1")
    object.__setattr__(settings, "llm_model", "fake-model")
    fake_llm.SCRIPT.clear()
    fake_llm.REQUESTS.clear()
    yield fake_llm
    object.__setattr__(settings, "llm_api_key", saved[0])
    object.__setattr__(settings, "llm_base_url", saved[1])
    object.__setattr__(settings, "llm_model", saved[2])


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
    assert llm.REQUESTS[-1]["tool_choice"] == "none"


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
