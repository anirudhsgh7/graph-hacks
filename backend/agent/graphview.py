"""Builds the bounded subgraph the UI draws: the nodes and edges behind the evidence,
plus what to highlight. Everything here is read back from FalkorDB by id."""
from __future__ import annotations

from agent.evidence import EvidenceLog
from agent.tools import iso, money
from graph.db import GraphView

MAX_NODES = 150
MAX_EDGES = 300
PRIORITY = ["freeze_plan", "path", "community", "simulation", "capacity", "shared_entities",
            "pattern", "no_path", "profile", "ranking"]


def build(view: GraphView, log: EvidenceLog, seeds: list[str] | None = None) -> dict:
    ordered: list[str] = list(seeds or [])
    edge_ids: list[str] = []
    evidence = sorted(log.all(), key=lambda e: PRIORITY.index(e.type) if e.type in PRIORITY else 99)
    for e in evidence:
        ordered.extend(e.node_ids)
        edge_ids.extend(e.edge_ids)
    node_ids = list(dict.fromkeys(ordered))[:MAX_NODES]
    return render(view, node_ids, list(dict.fromkeys(edge_ids))[:MAX_EDGES], highlight(log))


def render(view: GraphView, node_ids: list[str], edge_ids: list[str], hl: dict) -> dict:
    nodes = view.ro("graph_nodes", {"ids": node_ids}) if node_ids else []
    by_id = {n["id"]: n for n in nodes}
    present = [i for i in node_ids if i in by_id]
    edges = []
    if edge_ids:
        for t in view.ro("graph_transfers", {"ids": edge_ids}):
            if t["source"] in by_id and t["target"] in by_id:
                edges.append({"id": t["id"], "source": t["source"], "target": t["target"], "type": "TRANSFER",
                              "amount": money(t["amount"]), "ts": iso(t["ts"]), "channel": t["channel"]})
    accounts = [i for i in present if by_id[i]["label"] == "Account"]
    infra = [i for i in present if by_id[i]["label"] in ("Device", "IPAddress")]
    if accounts and infra:
        for link in view.ro("graph_infra_links", {"accounts": accounts, "infra": infra}):
            edges.append({"id": f"U:{link['source']}:{link['target']}", "source": link["source"],
                          "target": link["target"], "type": link["type"]})
    main_path = hl["paths"][0] if hl["paths"] else []
    out_nodes = []
    for i in present:
        n = by_id[i]
        node = {"id": i, "label": n["label"]}
        if n["label"] == "Account":
            node |= {"type": n["type"], "status": n["status"], "anomaly_score": n["anomaly_score"]}
        else:
            node |= {"kind": n["kind"]}
        if i in main_path and len(main_path) > 1:
            node |= {"x_hint": round(main_path.index(i) / (len(main_path) - 1), 3), "y_hint": 0.5}
        out_nodes.append(node)
    hl = dict(hl, frozen=[n["id"] for n in out_nodes if n.get("status") == "frozen"])
    return {"nodes": out_nodes, "edges": edges[:MAX_EDGES], "highlight": hl}


def highlight(log: EvidenceLog) -> dict:
    paths: list[list[str]] = []
    for e in log.of_type("path"):
        if e.result_excerpt.get("quality") in ("strong", "single_transfer") and e.node_ids not in paths:
            paths.append(e.node_ids)
    communities, clusters = [], []
    for e in log.of_type("community"):
        size = e.result_excerpt.get("community_size", 0)
        if e.result_excerpt.get("verdict") == "mule_ring":
            communities.append(e.node_ids[:size])
        elif e.result_excerpt.get("verdict") == "shared_infrastructure_only":
            clusters.append(e.node_ids[:size])
    plan = next((e for e in reversed(log.of_type("freeze_plan")) if e.result_excerpt.get("recommended")), None)
    cap = next((e for e in reversed(log.of_type("capacity"))), None)
    return {
        "paths": paths[:6],
        "communities": communities,
        "infrastructure_clusters": clusters,
        "freeze_plan": plan.result_excerpt["recommended"] if plan else [],
        "flows": cap.result_excerpt.get("flow_pairs", []) if cap else [],
    }
