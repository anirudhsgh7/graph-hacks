"""End-to-end over HTTP with the rule-based agent: the four demo scenarios, the
freeze action, the follow-up question and the receipts."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

AUTH = {"Authorization": "Bearer test-token"}


@pytest.fixture()
def client(fresh):
    from app.main import app
    return TestClient(app)


def ask(client, question, case_id):
    r = client.post("/api/investigate", json={"question": question, "case_id": case_id})
    assert r.status_code == 200, r.text
    return r.json()


def test_ground_truth_checks(seeded):
    from seed.load import load
    from seed.verify import collect_checks
    load()
    failed = [(n, d) for n, ok, d in collect_checks() if not ok]
    assert not failed, failed


def test_health(client):
    body = client.get("/api/health").json()
    assert body["db"] == "ok" and body["graph"]["accounts"] == 595


def test_scenario_1_burst_ring_and_minimum_freeze(client):
    p = ask(client, "Who is behind this burst of transfers?", "case-001")
    assert p["conclusion"] == "suspicious"
    ring = p["graph"]["highlight"]["communities"][0]
    assert sorted(ring) == ["A17", "A22", "A31", "A47", "A52", "A63", "A68"]
    freeze = next(a for a in p["proposed_actions"] if a["type"] == "freeze_accounts")
    assert freeze["account_ids"] == ["A47", "A52"]
    assert freeze["simulation"]["capacity_before"] == 30100 and freeze["simulation"]["capacity_after"] == 0
    # every finding and action cites evidence that exists in the payload
    ids = {e["id"] for e in p["evidence"]}
    assert all(set(f["evidence_refs"]) <= ids and f["evidence_refs"] for f in p["findings"])
    assert all(set(a["evidence_refs"]) <= ids and a["evidence_refs"] for a in p["proposed_actions"])
    # receipts name real queries with their Cypher
    assert all(r["cypher"] for e in p["evidence"] for r in e["receipts"])


def test_freeze_then_follow_up(client):
    p = ask(client, "Who is behind this burst of transfers?", "case-001")
    freeze = next(a for a in p["proposed_actions"] if a["type"] == "freeze_accounts")
    denied = client.post("/api/actions/execute", json={"action_id": freeze["id"], "confirm": True})
    assert denied.status_code == 401
    ok = client.post("/api/actions/execute", json={"action_id": freeze["id"], "confirm": True}, headers=AUTH)
    assert ok.status_code == 200 and ok.json()["affected"] == ["A47", "A52"]
    again = client.post("/api/actions/execute", json={"action_id": freeze["id"], "confirm": True}, headers=AUTH)
    assert again.status_code == 409 and again.json()["error"]["code"] == "ACTION_CONFLICT"
    follow = ask(client, "Is there any way around this freeze?", "case-001")
    cap = next(e for e in follow["evidence"] if e["type"] == "capacity")
    assert cap["result_excerpt"]["capacity"] == 0
    assert any(e["type"] == "no_path" for e in follow["evidence"])
    case = client.get("/api/cases/case-001").json()
    assert case["audit_trail"][0]["affected"] == ["A47", "A52"]
    assert len(case["investigations"]) == 2


def test_scenario_2_complaint_trace(client):
    p = ask(client, "Follow the $9,800 from C42.", "case-002")
    assert p["conclusion"] == "suspicious"
    assert ["C42", "A91", "A33", "A75", "H1"] in p["graph"]["highlight"]["paths"]


@pytest.mark.parametrize("case_id,question", [("case-003", "Is M8 laundering money?"),
                                              ("case-004", "Is the A95 cluster a mule ring?")])
def test_honest_false_alarms(client, case_id, question):
    p = ask(client, question, case_id)
    assert p["conclusion"] == "no_evidence" and p["status"] == "no_evidence"
    types = [a["type"] for a in p["proposed_actions"]]
    assert "freeze_accounts" not in types and "clear_alert" in types


def test_replay_receipt_and_refuse_writes(client):
    p = ask(client, "Who is behind this burst of transfers?", "case-001")
    receipt = p["evidence"][1]["receipts"][0]
    first = client.post("/api/evidence/replay", json={"query": receipt["query"], "params": receipt["params"]}).json()
    again = client.post("/api/evidence/replay", json={"query": receipt["query"], "params": receipt["params"],
                                                      "expected_fingerprint": first["fingerprint"]}).json()
    assert again["matches_expected"] is True
    bad = client.post("/api/evidence/replay", json={"query": "accounts_freeze", "params": {}})
    assert bad.status_code == 400


def test_errors_have_one_shape(client):
    r = client.post("/api/investigate", json={"question": ""})
    assert r.status_code == 400 and r.json()["error"]["code"] == "BAD_REQUEST"
    r = client.post("/api/investigate", json={"question": "hello"})
    assert r.status_code == 400 and "account" in r.json()["error"]["message"]
    r = client.get("/api/cases/nope")
    assert r.status_code == 404 and r.json()["error"]["code"] == "NOT_FOUND"


def test_stream_emits_steps_then_done(client):
    with client.stream("POST", "/api/investigate/stream",
                       json={"question": "Is M8 laundering money?", "case_id": "case-003"}) as r:
        text = "".join(r.iter_text())
    assert "event: step" in text and "event: finding" in text and text.rstrip().split("\n")[-2] == "event: done"


def test_report_markdown(client):
    ask(client, "Is M8 laundering money?", "case-003")
    md = client.get("/api/cases/case-003/report?format=markdown").text
    assert md.startswith("# Case report") and "no evidence" in md


def test_rate_limit(client):
    from app import main
    from app.config import settings
    object.__setattr__(settings, "investigate_rate_per_min", 2)
    main._hits.clear()
    try:
        codes = [client.post("/api/investigate", json={"question": "Is M8 laundering money?",
                                                       "case_id": "case-003"}).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
    finally:
        object.__setattr__(settings, "investigate_rate_per_min", 1000)
        main._hits.clear()
