"""Tests run against a real FalkorDB (local Docker or `redis-server --loadmodule falkordb.so`).

Tests reseed and finally delete the graph named by TEST_FALKORDB_GRAPH (default "ftm_test"),
so a developer's demo graph is never touched.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Always a dedicated graph: tests wipe it, so it must never be the demo graph,
# whatever FALKORDB_GRAPH says in the shell or in backend/.env.
os.environ["FALKORDB_GRAPH"] = os.environ.get("TEST_FALKORDB_GRAPH", "ftm_test")
os.environ["LLM_API_KEY"] = ""          # tests choose LLM behaviour explicitly
os.environ.setdefault("BACKEND_API_TOKEN", "test-token")
os.environ["INVESTIGATE_RATE_PER_MIN"] = "1000"   # rate limiting has its own test
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402


@pytest.fixture(scope="session")
def seeded():
    from graph.db import db
    if not db.ping():
        pytest.skip("FalkorDB is not running on FALKORDB_HOST:FALKORDB_PORT")
    from seed.load import load
    load()
    yield db
    db.cleanup_forks()
    try:
        db.client.select_graph(os.environ["FALKORDB_GRAPH"]).delete()
    except Exception:
        pass


@pytest.fixture()
def fresh(seeded):
    """Reseed before a test that changes account status (freezes)."""
    from seed.load import load
    load()
    return seeded
