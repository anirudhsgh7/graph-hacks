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
os.environ["LLM_FALLBACK_API_KEY"] = ""
os.environ["GEMINI_API_KEY"] = ""
os.environ.setdefault("BACKEND_API_TOKEN", "test-token")
os.environ["INVESTIGATE_RATE_PER_MIN"] = "1000"   # rate limiting has its own test
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest


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


# ---- scripted LLM (tests/fake_llm.py) for agent-loop tests ---------------------------
PORT = 8765


@pytest.fixture(scope="module")
def llm_server():
    from tests import fake_llm
    server = fake_llm.serve(PORT)
    yield
    server.should_exit = True


@pytest.fixture()
def llm(llm_server, fresh):
    """Point the agent at the fake server for one test."""
    from app.config import settings

    from tests import fake_llm
    keys = ("llm_api_key", "llm_base_url", "llm_model", "llm_fallback_api_key", "llm_fallback_base_url",
            "llm_fallback_model", "llm_reasoning_effort", "llm_max_wait_s")
    saved = {k: getattr(settings, k) for k in keys}
    object.__setattr__(settings, "llm_api_key", "test-key")
    object.__setattr__(settings, "llm_base_url", f"http://127.0.0.1:{PORT}/v1")
    object.__setattr__(settings, "llm_model", "fake-model")
    object.__setattr__(settings, "llm_fallback_api_key", None)   # tests opt in to a fallback
    object.__setattr__(settings, "llm_reasoning_effort", None)
    for lst in (fake_llm.SCRIPT, fake_llm.REQUESTS, fake_llm.SCRIPT_ALT, fake_llm.REQUESTS_ALT):
        lst.clear()
    yield fake_llm
    for k, v in saved.items():
        object.__setattr__(settings, k, v)
