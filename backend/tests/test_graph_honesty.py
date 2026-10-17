"""Three guarantees that keep the agent honest about the graph:
names are resolved before any reasoning, the model's prose is fact-checked against
graph results, and memory of other cases is recalled by walking from the accounts."""
from __future__ import annotations

import json

import pytest
from agent import factcheck
from fastapi.testclient import TestClient

from tests.fake_llm import reply_text, reply_tools
from tests.test_agent_llm import RING_SCRIPT, _investigate

AUTH = {"Authorization": "Bearer test-token"}
CASES = ["case-001", "case-002", "case-003", "case-004"]


@pytest.fixture()
def client(fresh):
    from app.main import app
    return TestClient(app)


def ask(client, question, case_id=None):
    r = client.post("/api/investigate", json={"question": question, "case_id": case_id})
    assert r.status_code == 200, r.text
    return r.json()


# ---- 1. resolve names against the graph -------------------------------------------
def test_unknown_account_is_not_in_graph(client):
    r = client.post("/api/investigate", json={"question": "Is A999 laundering money?", "case_id": "case-001"})
    assert r.status_code == 404
    err = r.json()["error"]
    assert err["code"] == "NOT_IN_GRAPH" and err["message"].startswith("A999 is not in the graph")
    # the case's own accounts are NOT silently investigated instead
    detail = client.get("/api/cases/case-001").json()
    assert detail.get("latest_investigation") is None


def test_unknown_account_costs_no_model_call(llm):
    from agent.loop import InvestigationError
    with pytest.raises(InvestigationError) as exc:
        _investigate("Compare A17 with A999 and Z1", "case-001")
    assert exc.value.code == "NOT_IN_GRAPH" and "A999" in exc.value.message
    assert llm.REQUESTS == []


# ---- 2. fact-check the model's prose ------------------------------------------------
def test_deterministic_summaries_pass_the_fact_check(client):
    """The fallback must itself be clean, or replacing a summary would be pointless."""
    for case_id in CASES:
        p = ask(client, "Investigate this alert", case_id)
        assert factcheck.check(p["summary"], p["evidence"]) == [], (case_id, p["summary"])
        assert p["meta"]["summary_check"] == "not_needed"


def test_amount_precision_and_unknown_claims():
    ev = [{"node_ids": ["A17", "H3"], "result_excerpt": {"capacity": 30100.0, "minutes": 36}}]
    assert factcheck.check("Up to $30,100 (about $30.1K) can reach H3 from A17.", ev) == []
    bad = factcheck.check("A17 sent $45,000 to A999.", ev)
    assert bad == ["A999 does not appear in any graph result",
                   "$45,000 does not match any amount the graph returned"]
    assert factcheck.check("A999 was frozen earlier.", ev, context_accounts={"A999"}) == []


def _llm_answer(llm, summary, findings=None):
    final = {"conclusion": "suspicious", "summary": summary,
             "findings": findings or [{"title": "Ring", "detail": "7 accounts share devices",
                                       "confidence": 0.9, "evidence_refs": ["ev-3"]}]}
    llm.SCRIPT.extend(RING_SCRIPT + [reply_text(json.dumps(final))])
    return _investigate()


def test_supported_summary_passes(llm):
    p = _llm_answer(llm, "A17 runs a mule ring; up to $30,100 can reach H3 and freezing A47 and A52 stops it.")
    assert p["meta"]["summary_check"] == "passed"
    assert p["summary"].startswith("A17 runs a mule ring")


def test_invented_amount_replaces_summary(llm):
    p = _llm_answer(llm, "A17 moved $250,000 through the ring to H3.")
    assert p["meta"]["summary_check"] == "replaced"
    assert "$250,000" not in p["summary"] and "$30,100" in p["summary"]
    assert any("fact-check: $250,000 does not match" in n for n in p["meta"]["notes"])


def test_invented_account_in_finding_is_dropped(llm):
    p = _llm_answer(llm, "A17 runs a mule ring.", findings=[
        {"title": "Ring", "detail": "7 accounts share devices", "confidence": 0.9, "evidence_refs": ["ev-3"]},
        {"title": "Cash-out", "detail": "money ends at A404", "confidence": 0.8, "evidence_refs": ["ev-5"]}])
    assert [f["title"] for f in p["findings"]] == ["Ring"]
    assert any("dropped finding 'Cash-out'" in n for n in p["meta"]["notes"])


# ---- 3. memory as graph: recall other cases -----------------------------------------
def test_recall_across_cases(client):
    first = ask(client, "Who is behind this burst of transfers?", "case-001")
    assert first["recall"] == []
    # the investigation is now linked to the accounts it implicated
    from graph.db import db
    linked = db.live().ro("recall_investigations", {"ids": ["A47"], "case_id": "case-999"})
    assert linked and linked[0]["case_id"] == "case-001"

    # a different case asks about one of those accounts: the agent remembers
    later = ask(client, "What do we know about A47?", "case-004")
    assert [(r["case_id"], r["kind"]) for r in later["recall"]] == [("case-001", "investigated")]
    assert "A47" in later["recall"][0]["account_ids"]

    # after the freeze in case-001, the action is recalled too
    freeze = next(a for a in first["proposed_actions"] if a["type"] == "freeze_accounts")
    ok = client.post("/api/actions/execute", json={"action_id": freeze["id"], "confirm": True,
                                                   "case_id": "case-001"}, headers=AUTH)
    assert ok.status_code == 200
    again = ask(client, "What do we know about A47?", None)
    kinds = {r["kind"] for r in again["recall"] if r["case_id"] == "case-001"}
    assert kinds == {"investigated", "action"}
    # the same case never "recalls" itself
    own = ask(client, "Who is behind this burst of transfers?", "case-001")
    assert all(r["case_id"] != "case-001" for r in own["recall"])


def test_recall_reaches_the_model(llm):
    _llm_answer(llm, "A17 runs a mule ring.")                     # case-001, implicates A47
    llm.REQUESTS.clear()
    llm.SCRIPT.extend([reply_tools(), reply_text("not json"), reply_text("still not json")])
    _investigate("What do we know about A47?", "case-004")
    first_user = llm.REQUESTS[0]["messages"][1]["content"]
    assert "Seen in other cases (from the graph): " in first_user and "case-001" in first_user
