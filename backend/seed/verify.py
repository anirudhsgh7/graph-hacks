"""Assert that the product's own tools rediscover the planted ground truth.

    python -m seed.verify          (from backend/, after seed.load)

Run before every demo. Exits non-zero if anything drifted. Hidden ground-truth
properties (ring_id, is_laundering) are read only here, never by the product.
"""
from __future__ import annotations

import json
import sys

from agent.tools import Run, call_tool
from graph.db import db
from graph.flow import max_flow
from seed.load import GROUND_TRUTH_FILE


def collect_checks() -> list[tuple[str, bool, str]]:
    """Run every check and return (name, passed, detail) tuples."""
    gt = json.loads(GROUND_TRUTH_FILE.read_text(encoding="utf-8"))
    run = Run(db)
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, bool(ok), detail))

    def tool(name: str, **args):
        out = call_tool(run, name, args)
        if "error" in out:
            raise AssertionError(f"{name} failed: {out['error']}")
        return out

    try:
        frozen = db.frozen_accounts()
        check("no accounts frozen (fresh seed)", not frozen, f"frozen={frozen}")

        for ring_id, members in gt["rings"].items():
            out = tool("detect_ring", account_ids=[members[0]])
            group = out["groups"][0] if out["groups"] else {}
            check(f"ring {ring_id} found exactly by detect_ring",
                  sorted(group.get("members", [])) == sorted(members) and group.get("verdict") == "mule_ring",
                  f"got {group.get('members')} verdict={group.get('verdict')}")

        fam = tool("detect_ring", account_ids=[gt["benign_clusters"]["family"][0]])
        check("family cluster is NOT a ring", fam["verdict"] == "shared_infrastructure_only", fam["verdict"])
        m8 = tool("detect_ring", account_ids=gt["benign_clusters"]["merchant"])
        check("merchant has no ring", m8["verdict"] == "no_ring", m8["verdict"])
        prof = tool("account_profile", account_id="M8")
        check("merchant tops the legacy anomaly score", prof["anomaly_rank"] == 1, f"rank {prof['anomaly_rank']}")

        trail = tool("money_trail", src="A17", dst=gt["hubs"]["1"])
        strong = [p for p in trail["paths"] if p["quality"] == "strong"]
        check("A17 -> H3 has strong 4-hop trails", strong and all(p["hops"] == 4 for p in strong),
              f"{len(strong)} strong paths")
        check("bypass route through A77 is visible",
              any(gt["ring1_bypass_account"] in p["nodes"] for p in trail["paths"]))

        cap = tool("laundering_capacity", entry_ids=gt["ring1_entries"], hub_ids=[gt["hubs"]["1"]])
        check("ring 1 capacity to H3", abs(cap["capacity"] - gt["ring1_capacity_to_H3"]) < 0.01,
              f"{cap['capacity']} via {cap['engine']}")
        if db.capabilities().get("maxflow"):
            from agent.tools import _flow_edges
            edges = _flow_edges(db.live())[0]
            py = max_flow(edges, gt["ring1_entries"], [gt["hubs"]["1"]]).value
            check("native algo.maxFlow agrees with the Python solver", abs(py - cap["capacity"]) < 0.01,
                  f"native={cap['capacity']} python={py}")

        plan = tool("plan_minimum_freeze", entry_ids=gt["ring1_entries"], hub_ids=[gt["hubs"]["1"]])
        rec = plan["recommended"]
        check("minimum freeze plan", rec["accounts"] == gt["ring1_minimum_freeze"], f"got {rec['accounts']}")
        check("plan proven on a fork: capacity 0 and no route left",
              rec["capacity_after"] == 0 and rec["remaining_paths"] == 0,
              f"capacity_after={rec['capacity_after']} paths={rec['remaining_paths']}")
        aggregator = next((a for a in plan["alternatives"] if "aggregator" in a["plan"]), None)
        check("naive 'freeze the aggregator' leaves the A77 bypass",
              aggregator is not None and aggregator["capacity_after"] > 0
              and gt["ring1_bypass_account"] in (aggregator["residual_route"] or []),
              str(aggregator and aggregator["residual_route"]))

        funds = tool("follow_funds", account_id="C42")
        path = [funds["start_account"]] + [h["to"] for h in funds["hops"]]
        check("C42 complaint traced hop by hop", path == gt["c42_chain"], f"got {path}")
        check("C42 chain duration", funds["minutes_total"] == gt["c42_chain_minutes"], f"{funds['minutes_total']} min")

        leftovers = [g for g in db.client.list_graphs() if "__fork__" in g]
        check("no forks left behind", not leftovers, str(leftovers))
    except AssertionError as exc:  # a tool returned an error: record it as a failed check
        check("tools ran without errors", False, str(exc))
    return results


def run_checks() -> bool:
    results = collect_checks()
    width = max(len(n) for n, *_ in results)
    for name, ok, detail in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name.ljust(width)}  {detail}")
    failed = sum(1 for _, ok, _ in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} checks passed"
          + ("" if not failed else f" - {failed} FAILED"))
    return failed == 0


if __name__ == "__main__":
    sys.exit(0 if run_checks() else 1)
