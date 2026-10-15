"""Runtime configuration, read once from environment variables.

Every setting has a safe local default so `uvicorn app.main:app` works on a fresh
laptop with FalkorDB running in Docker. Secrets (LLM key, DB password) are only
ever read from the environment - never hard-coded, never sent to the browser.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

# A local backend/.env (git-ignored) overrides nothing that is already set in the
# real environment, so Render's dashboard values always win in production.
load_dotenv(BACKEND_DIR / ".env", override=False)


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    raw = os.getenv(name)
    return int(raw) if raw and raw.strip() else default


def _list(name: str, default: list[str]) -> list[str]:
    raw = os.getenv(name)
    if not raw:
        return default
    return [item.strip() for item in raw.split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # FalkorDB
    falkordb_host: str = field(default_factory=lambda: os.getenv("FALKORDB_HOST", "localhost"))
    falkordb_port: int = field(default_factory=lambda: _int("FALKORDB_PORT", 6379))
    falkordb_username: str | None = field(default_factory=lambda: os.getenv("FALKORDB_USERNAME") or None)
    falkordb_password: str | None = field(default_factory=lambda: os.getenv("FALKORDB_PASSWORD") or None)
    falkordb_tls: bool = field(default_factory=lambda: _bool("FALKORDB_TLS", False))
    graph_name: str = field(default_factory=lambda: os.getenv("FALKORDB_GRAPH", "ftm"))

    # LLM (any OpenAI-compatible endpoint; Groq by default)
    llm_base_url: str = field(default_factory=lambda: os.getenv("LLM_BASE_URL", "https://api.groq.com/openai/v1"))
    llm_api_key: str | None = field(default_factory=lambda: os.getenv("LLM_API_KEY") or None)
    llm_model: str = field(default_factory=lambda: os.getenv("LLM_MODEL", "openai/gpt-oss-120b"))
    llm_timeout_s: int = field(default_factory=lambda: _int("LLM_TIMEOUT_S", 30))

    # Agent limits
    agent_max_turns: int = field(default_factory=lambda: _int("AGENT_MAX_TURNS", 6))
    agent_max_tool_calls: int = field(default_factory=lambda: _int("AGENT_MAX_TOOL_CALLS", 12))
    agent_budget_s: int = field(default_factory=lambda: _int("AGENT_BUDGET_S", 45))

    # HTTP
    cors_origins: list[str] = field(
        default_factory=lambda: _list("CORS_ORIGINS", ["http://localhost:3000"])
    )
    api_token: str | None = field(default_factory=lambda: os.getenv("BACKEND_API_TOKEN") or None)
    investigate_rate_per_min: int = field(default_factory=lambda: _int("INVESTIGATE_RATE_PER_MIN", 10))

    queries_dir: Path = field(
        default_factory=lambda: Path(os.getenv("QUERIES_DIR", str(REPO_DIR / "queries")))
    )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_api_key)


settings = Settings()
