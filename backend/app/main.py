"""FastAPI app: the HTTP contract between the console and the agent (docs/api-contract.md).

Run locally (from backend/):   uvicorn app.main:app --reload --port 8000
Interactive docs:              http://localhost:8000/docs
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import ResponseError as RedisResponseError
from redis.exceptions import TimeoutError as RedisTimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException

from agent import actions as actions_mod
from agent import graphview
from agent.evidence import EvidenceLog, fingerprint
from agent.loop import InvestigationError, investigate
from agent.tools import iso
from app import report
from app.config import settings
from app.schemas import (CaseDetail, CaseSummary, ErrorResponse, ExecuteActionRequest,
                         ExecuteActionResponse, Graph, HealthResponse, InvestigateRequest,
                         InvestigateResponse, ReplayRequest)
from graph.db import db
from graph.queries import catalog

VERSION = "1.0.0"
log = logging.getLogger("ftm")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Queries the replay endpoint may run: the read-only product queries (files 01-04).
REPLAYABLE_FILES = {"01_accounts.cypher", "02_rings.cypher", "03_trails.cypher", "04_flow.cypher"}
NOT_REPLAYABLE = {"fork_remove_accounts"}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.detail = status, code, message, detail or {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        dropped = db.cleanup_forks()
        if dropped:
            log.info("dropped %d leftover fork graph(s)", dropped)
        log.info("FalkorDB capabilities: %s", db.capabilities())
    except Exception as exc:  # DB down at boot: health endpoint reports it
        log.warning("FalkorDB not reachable at startup: %s", exc)
    yield


app = FastAPI(
    title="Follow the Money - AML investigation API",
    version=VERSION,
    description="Agent that investigates suspicious money movement on a FalkorDB transaction graph.",
    lifespan=lifespan,
    responses={400: {"model": ErrorResponse}, 503: {"model": ErrorResponse}},
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


# ---- errors: one shape for every endpoint -------------------------------------------
def _error(status: int, code: str, message: str, detail: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message, "detail": detail or {}}})


@app.exception_handler(ApiError)
async def _api_error(_r: Request, exc: ApiError):
    return _error(exc.status, exc.code, exc.message, exc.detail)


@app.exception_handler(InvestigationError)
async def _inv_error(_r: Request, exc: InvestigationError):
    return _error(400, exc.code, exc.message)


@app.exception_handler(actions_mod.ActionError)
async def _action_error(_r: Request, exc: actions_mod.ActionError):
    return _error(409 if exc.code == "ACTION_CONFLICT" else 400, exc.code, exc.message, exc.detail)


@app.exception_handler(RequestValidationError)
async def _validation_error(_r: Request, exc: RequestValidationError):
    errors = [{"field": ".".join(str(p) for p in e["loc"][1:]), "problem": e["msg"]} for e in exc.errors()]
    return _error(400, "BAD_REQUEST", "the request is not valid", {"errors": errors})


@app.exception_handler(StarletteHTTPException)
async def _http_error(_r: Request, exc: StarletteHTTPException):
    code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(exc.status_code, "BAD_REQUEST")
    return _error(exc.status_code, code, str(exc.detail))


@app.exception_handler(RedisConnectionError)
@app.exception_handler(RedisTimeoutError)
async def _db_down(_r: Request, exc: Exception):
    log.error("database unreachable: %s", exc)
    return _error(503, "DB_UNAVAILABLE", "the graph database is unreachable - it may be waking up or "
                                         "need a reseed; retry in a moment")


@app.exception_handler(Exception)
async def _internal(_r: Request, exc: Exception):
    log.exception("unhandled error")
    return _error(500, "INTERNAL", "unexpected server error")


# ---- guards --------------------------------------------------------------------------
_hits: dict[str, deque] = defaultdict(deque)
_hits_lock = threading.Lock()


def rate_limit(request: Request) -> None:
    ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "?")).split(",")[0]
    now = time.time()
    with _hits_lock:
        q = _hits[ip]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= settings.investigate_rate_per_min:
            raise ApiError(429, "RATE_LIMITED", f"at most {settings.investigate_rate_per_min} investigations "
                                                "per minute - try again shortly")
        q.append(now)


def require_token(authorization: str | None = Header(default=None)) -> None:
    """Mutating endpoints need `Authorization: Bearer <BACKEND_API_TOKEN>` when a token is set."""
    if settings.api_token and authorization != f"Bearer {settings.api_token}":
        raise ApiError(401, "UNAUTHORIZED", "missing or wrong Authorization header")


# ---- helpers -------------------------------------------------------------------------
def _case_summary(row: dict) -> dict:
    return {"id": row["id"], "title": row["title"], "alert": row["alert"], "status": row["status"],
            "seed_accounts": row["seed_accounts"] or [], "created_at": iso(row["created_at"]),
            "suggested_questions": row["suggested_questions"] or []}


def _get_case(case_id: str) -> dict:
    rows = db.live().ro("case_get", {"id": case_id})
    if not rows:
        raise ApiError(404, "NOT_FOUND", f"unknown case {case_id}")
    return rows[0]


def _latest(case_id: str) -> dict | None:
    rows = db.live().ro("investigation_latest", {"case_id": case_id})
    return json.loads(rows[0]["payload"]) if rows else None


# ---- endpoints -----------------------------------------------------------------------
@app.get("/api/health", response_model=HealthResponse)
def health() -> dict:
    ok = db.ping()
    counts = caps = None
    if ok:
        try:
            row = db.live().ro("graph_counts")
            counts = {"accounts": row[0]["accounts"], "transfers": row[0]["transfers"]} if row else \
                {"accounts": 0, "transfers": 0}
            caps = db.capabilities()
        except Exception as exc:  # graph missing (not seeded yet)
            log.warning("health: %s", exc)
            counts = {"accounts": 0, "transfers": 0}
    seeded = bool(counts and counts["accounts"])
    return {"status": "ok" if ok and seeded else "degraded", "db": "ok" if ok else "unreachable",
            "llm": "configured" if settings.llm_enabled else "not_configured",
            "llm_model": settings.llm_model if settings.llm_enabled else None,
            "graph": counts, "capabilities": caps, "version": VERSION}


@app.get("/api/cases", response_model=list[CaseSummary])
def list_cases() -> list[dict]:
    return [_case_summary(r) for r in db.live().ro("case_list")]


@app.get("/api/cases/{case_id}", response_model=CaseDetail)
def get_case(case_id: str) -> dict:
    live = db.live()
    case = _case_summary(_get_case(case_id))
    case["investigations"] = [
        {"id": r["id"], "question": r["question"], "created_at": iso(r["created_at"]),
         "conclusion": r["conclusion"], "mode": r["mode"], "summary": r["summary"]}
        for r in live.ro("investigation_list", {"case_id": case_id})]
    case["audit_trail"] = [
        {"id": r["id"], "type": r["type"], "label": r["label"], "created_at": iso(r["created_at"]),
         "account_ids": r["account_ids"] or [], "affected": r["affected"] or [],
         "evidence_refs": r["evidence_refs"] or []}
        for r in live.ro("audit_trail", {"case_id": case_id})]
    case["latest_investigation"] = _latest(case_id)
    return case


@app.post("/api/investigate", response_model=InvestigateResponse, dependencies=[Depends(rate_limit)])
def post_investigate(body: InvestigateRequest) -> dict:
    return investigate(db, body.question, body.case_id)


@app.post("/api/investigate/stream", dependencies=[Depends(rate_limit)],
          responses={200: {"content": {"text/event-stream": {}}}})
def post_investigate_stream(body: InvestigateRequest) -> StreamingResponse:
    """Server-Sent Events: `step` (started/done per tool), `finding`, then `done` with the
    full InvestigateResponse - or `error` with the standard error body."""
    events: queue.Queue = queue.Queue()

    def work() -> None:
        try:
            payload = investigate(db, body.question, body.case_id,
                                  on_event=lambda t, d: events.put((t, d)))
            events.put(("done", InvestigateResponse.model_validate(payload).model_dump(mode="json")))
        except InvestigationError as exc:
            events.put(("error", {"code": exc.code, "message": exc.message, "detail": {}}))
        except (RedisConnectionError, RedisTimeoutError):
            events.put(("error", {"code": "DB_UNAVAILABLE", "message": "the graph database is unreachable",
                                  "detail": {}}))
        except Exception:
            log.exception("stream investigation failed")
            events.put(("error", {"code": "INTERNAL", "message": "unexpected server error", "detail": {}}))

    threading.Thread(target=work, daemon=True).start()

    def stream() -> Iterator[str]:
        deadline = time.time() + settings.agent_budget_s + 60
        while time.time() < deadline:
            try:
                kind, data = events.get(timeout=15)
            except queue.Empty:
                yield ": keep-alive\n\n"
                continue
            yield f"event: {kind}\ndata: {json.dumps(data, default=str)}\n\n"
            if kind in ("done", "error"):
                return
        yield 'event: error\ndata: {"code": "AGENT_TIMEOUT", "message": "investigation timed out"}\n\n'

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/actions/execute", response_model=ExecuteActionResponse, dependencies=[Depends(require_token)])
def execute_action(body: ExecuteActionRequest) -> dict:
    if not body.confirm:
        raise ApiError(400, "BAD_REQUEST", "set confirm: true to execute an action")
    return actions_mod.execute(db, body.action_id, body.case_id)


@app.get("/api/graph/snapshot", response_model=Graph)
def graph_snapshot(case_id: str = Query(...)) -> dict:
    """Current subgraph for the canvas: the latest investigation's evidence (with fresh
    account statuses), or the seed accounts' neighbourhood before any investigation."""
    case = _get_case(case_id)
    live = db.live()
    latest = _latest(case_id)
    if latest:
        g = latest["graph"]
        node_ids = [n["id"] for n in g["nodes"]]
        edge_ids = [e["id"] for e in g["edges"] if e["type"] == "TRANSFER"]
        return graphview.render(live, node_ids, edge_ids, g["highlight"])
    seeds = case["seed_accounts"] or []
    rows = live.ro("neighborhood_transfers", {"ids": seeds, "limit": 40}) if seeds else []
    transfers = live.ro("graph_transfers", {"ids": [r["id"] for r in rows]}) if rows else []
    node_ids = list(dict.fromkeys(seeds + [n for t in transfers for n in (t["source"], t["target"])]))
    return graphview.render(live, node_ids, [t["id"] for t in transfers], graphview.highlight(EvidenceLog()))


@app.get("/api/cases/{case_id}/report")
def case_report(case_id: str, format: str = Query("json", pattern="^(json|markdown)$")) -> Any:
    case = get_case(case_id)
    data = report.build(case)
    if format == "markdown":
        return PlainTextResponse(report.to_markdown(data), media_type="text/markdown; charset=utf-8")
    return data


@app.post("/api/evidence/replay")
def replay(body: ReplayRequest) -> dict:
    """Receipts: re-run the exact named query behind a piece of evidence, read-only."""
    q = catalog().get(body.query)
    if q is None or q.file not in REPLAYABLE_FILES or q.name in NOT_REPLAYABLE:
        raise ApiError(400, "BAD_REQUEST", f"'{body.query}' is not a replayable read-only query")
    try:
        rows = db.live().ro(q.name, body.params)
    except RedisResponseError as exc:
        raise ApiError(400, "BAD_REQUEST", f"query failed: {exc}") from exc
    fp = fingerprint(rows)
    return {"query": q.name, "cypher": q.cypher, "params": body.params, "row_count": len(rows),
            "rows": rows[:50], "fingerprint": fp,
            "matches_expected": None if body.expected_fingerprint is None else fp == body.expected_fingerprint}


@app.get("/api/queries")
def list_queries() -> list[dict]:
    """Every Cypher query the product runs, as loaded from queries/*.cypher."""
    return [{"name": q.name, "file": q.file, "description": q.description, "cypher": q.cypher}
            for q in catalog().values()]


@app.post("/api/admin/reseed", dependencies=[Depends(require_token)])
def reseed() -> dict:
    """Wipe and rebuild the demo graph, then verify the planted ground truth.
    Disabled unless BACKEND_API_TOKEN is set (so strangers cannot reset the demo)."""
    if not settings.api_token:
        raise ApiError(403, "FORBIDDEN", "set BACKEND_API_TOKEN to enable reseeding over HTTP")
    from seed.load import load
    from seed.verify import collect_checks
    stats = load()
    checks = collect_checks()
    return {"loaded": stats, "checks": [{"name": n, "ok": ok, "detail": d} for n, ok, d in checks],
            "all_passed": all(ok for _, ok, _ in checks),
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
