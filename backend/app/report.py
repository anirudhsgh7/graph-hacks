"""Case report: assembled deterministically from the stored investigation, its evidence
and the audit trail - nothing in it is generated at export time."""
from __future__ import annotations

from datetime import datetime, timezone


def build(case: dict) -> dict:
    inv = case.get("latest_investigation")
    evidence = {e["id"]: e for e in (inv or {}).get("evidence", [])}
    findings = []
    for f in (inv or {}).get("findings", []):
        findings.append(dict(f, evidence=[{
            "id": r, "type": evidence[r]["type"], "tool": evidence[r]["tool"],
            "accounts": [n for n in evidence[r]["node_ids"] if not n.startswith(("D-", "IP-"))],
            "transfers": evidence[r]["edge_ids"][:20],
            "facts": evidence[r]["result_excerpt"],
            "queries": [rc["query"] for rc in evidence[r]["receipts"]],
        } for r in f["evidence_refs"] if r in evidence]))
    executed = {a["id"] for a in case["audit_trail"]}
    return {
        "report_type": "suspicious activity investigation",
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "case": {k: case[k] for k in ("id", "title", "alert", "status", "seed_accounts", "created_at")},
        "investigation": None if not inv else {
            "id": inv["investigation_id"], "question": inv["question"], "created_at": inv["created_at"],
            "conclusion": inv["conclusion"], "summary": inv["summary"], "mode": inv["meta"]["mode"],
            "narrative_source": inv["meta"]["narrative_source"],
        },
        "findings": findings,
        "actions_taken": case["audit_trail"],
        "open_proposals": [a for a in (inv or {}).get("proposed_actions", []) if a["id"] not in executed],
        "method": ("All facts come from FalkorDB queries listed per finding (see queries/*.cypher). "
                   "The verdict is a fixed rule over graph measurements; freeze effects were "
                   "re-computed on a copy of the graph."),
        "data_notice": "Synthetic data generated for a hackathon demo. No real persons or accounts.",
    }


def to_markdown(r: dict) -> str:
    c = r["case"]
    lines = [f"# Case report - {c['title']}", "",
             f"*Case {c['id']} - status {c['status']} - generated {r['generated_at']}*", "",
             "## Alert", c["alert"], ""]
    inv = r["investigation"]
    if not inv:
        lines += ["## Investigation", "No investigation has been run on this case yet.", ""]
    else:
        lines += ["## Conclusion", f"**{inv['conclusion'].replace('_', ' ')}** - {inv['summary']}", "",
                  f"Question asked: \"{inv['question']}\" ({inv['created_at']})", "", "## Findings"]
        for f in r["findings"]:
            lines += ["", f"### {f['title']}", f["detail"], "",
                      f"Confidence {round(100 * f['confidence'])}%. Evidence:"]
            for e in f["evidence"]:
                accounts = ", ".join(e["accounts"][:12]) or "-"
                lines.append(f"- {e['id']} ({e['type']}, via {e['tool']}): accounts {accounts}; "
                             f"queries {', '.join(e['queries'])}")
        lines.append("")
    lines.append("## Actions taken")
    if r["actions_taken"]:
        for a in r["actions_taken"]:
            touched = ", ".join(a["affected"]) or "-"
            lines.append(f"- {a['created_at']}: {a['label']} (accounts affected: {touched}; "
                         f"evidence {', '.join(a['evidence_refs'])})")
    else:
        lines.append("- None yet.")
    if r["open_proposals"]:
        lines += ["", "## Open proposals"]
        lines += [f"- {a['label']}" for a in r["open_proposals"]]
    lines += ["", "## Method", r["method"], "", f"_{r['data_notice']}_", ""]
    return "\n".join(lines)
