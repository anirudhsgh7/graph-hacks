"""Wipe and rebuild the demo graph, deterministically.

    python -m seed.load                    # uses FALKORDB_* from backend/.env
    python -m seed.load --host h --port p --username falkordb --password ...

Run from the backend/ folder. Takes a few seconds; prints counts; writes
seed/seed_groundtruth.json. Run seed.verify afterwards (or pass --verify).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

BATCH = 500
GROUND_TRUTH_FILE = Path(__file__).resolve().parent / "seed_groundtruth.json"


def _batches(rows: list[dict]):
    for i in range(0, len(rows), BATCH):
        yield rows[i:i + BATCH]


def load(graph=None) -> dict:
    """Rebuild the graph. `graph` is a falkordb Graph; defaults to the configured one."""
    from graph.db import GraphView, db
    from seed.generator import build_world

    started = time.time()
    world = build_world()
    if graph is None:
        db.cleanup_forks()
        graph = db.client.select_graph(_graph_name())
    try:
        graph.delete()
    except Exception:
        pass  # graph did not exist yet
    view = GraphView(graph, graph.name)

    for idx in ["idx_account", "idx_customer", "idx_device", "idx_ip", "idx_case",
                "idx_investigation", "idx_proposal", "idx_transfer"]:
        view.rw(idx)

    steps = [
        ("load_customers", world.customers),
        ("load_accounts", world.accounts),
        ("load_devices", world.devices),
        ("load_ips", world.ips),
        ("load_owns", world.owns),
        ("load_used_device", world.used_device),
        ("load_used_ip", world.used_ip),
        ("load_transfers", world.transfers),
        ("load_flows", world.flows),
        ("load_cases", world.cases),
    ]
    for name, rows in steps:
        for chunk in _batches(rows):
            view.rw(name, {"rows": chunk}, timeout_ms=60000)

    db.invalidate_active()
    GROUND_TRUTH_FILE.write_text(json.dumps(world.ground_truth, indent=2) + "\n", encoding="utf-8")
    return {
        "customers": len(world.customers), "accounts": len(world.accounts),
        "devices": len(world.devices), "ips": len(world.ips),
        "transfers": len(world.transfers), "flows": len(world.flows),
        "cases": len(world.cases), "seconds": round(time.time() - started, 2),
    }


def _graph_name() -> str:
    from app.config import settings
    return settings.graph_name


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host")
    ap.add_argument("--port", type=int)
    ap.add_argument("--username")
    ap.add_argument("--password")
    ap.add_argument("--graph")
    ap.add_argument("--verify", action="store_true", help="run seed.verify after loading")
    args = ap.parse_args()
    # CLI flags override the environment before settings are first imported.
    for flag, env in [("host", "FALKORDB_HOST"), ("port", "FALKORDB_PORT"),
                      ("username", "FALKORDB_USERNAME"), ("password", "FALKORDB_PASSWORD"),
                      ("graph", "FALKORDB_GRAPH")]:
        value = getattr(args, flag)
        if value is not None:
            os.environ[env] = str(value)

    stats = load()
    print("loaded:", ", ".join(f"{k}={v}" for k, v in stats.items()))
    print(f"ground truth -> {GROUND_TRUTH_FILE}")
    if args.verify:
        from seed.verify import run_checks
        return 0 if run_checks() else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
