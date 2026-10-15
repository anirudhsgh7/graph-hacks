"""API request/response models. These define backend/openapi.json, from which the
frontend's lib/types.ts is generated - change them only through docs/api-contract.md."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---- requests ---------------------------------------------------------------------
class InvestigateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=1000,
                          examples=["Who is behind the burst of transfers from account A17?"])
    case_id: str | None = Field(default=None, examples=["case-001"])


class ExecuteActionRequest(BaseModel):
    action_id: str
    confirm: bool
    case_id: str | None = None


class ReplayRequest(BaseModel):
    query: str = Field(examples=["shared_infrastructure"])
    params: dict[str, Any] = Field(default_factory=dict, examples=[{"id": "A17"}])
    expected_fingerprint: str | None = None


# ---- investigate response -----------------------------------------------------------
class Finding(BaseModel):
    id: str
    title: str
    detail: str
    confidence: float
    evidence_refs: list[str]


class Receipt(BaseModel):
    query: str
    params: dict[str, Any]
    cypher: str


class EvidenceItem(BaseModel):
    id: str
    type: str
    tool: str
    node_ids: list[str]
    edge_ids: list[str]
    result_excerpt: dict[str, Any]
    receipts: list[Receipt]


class Simulation(BaseModel):
    capacity_before: float
    capacity_after: float
    residual_routes: list[list[str]] = []
    remaining_paths: int | None = None
    verified_on: str


class ProposedAction(BaseModel):
    id: str
    type: Literal["freeze_accounts", "flag_accounts", "clear_alert", "export_case_report"]
    label: str
    account_ids: list[str]
    requires_confirmation: bool
    evidence_refs: list[str]
    simulation: Simulation | None = None


class TraceStep(BaseModel):
    step: int
    tool: str
    args: dict[str, Any]
    ok: bool
    rows: int
    duration_ms: int
    headline: str
    evidence_ids: list[str]
    error: str | None = None


class GraphNode(BaseModel):
    id: str
    label: Literal["Account", "Device", "IPAddress"]
    type: str | None = None
    kind: str | None = None
    status: str | None = None
    anomaly_score: float | None = None
    x_hint: float | None = None
    y_hint: float | None = None


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    type: Literal["TRANSFER", "USED_DEVICE", "USED_IP"]
    amount: float | None = None
    ts: str | None = None
    channel: str | None = None


class Highlight(BaseModel):
    paths: list[list[str]] = []
    communities: list[list[str]] = []
    infrastructure_clusters: list[list[str]] = []
    freeze_plan: list[str] = []
    flows: list[list[str]] = []
    frozen: list[str] = []


class Graph(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    highlight: Highlight


class Meta(BaseModel):
    mode: Literal["llm", "rule_based"]
    model: str | None
    narrative_source: Literal["llm", "deterministic"]
    tool_iterations: int
    latency_ms: int
    maxflow_engine: Literal["falkordb", "python"]
    frozen_accounts: list[str]
    notes: list[str]


class InvestigateResponse(BaseModel):
    investigation_id: str
    case_id: str | None
    question: str
    created_at: str
    status: Literal["complete", "no_evidence", "partial"]
    conclusion: Literal["suspicious", "no_evidence", "inconclusive"]
    summary: str
    findings: list[Finding]
    evidence: list[EvidenceItem]
    proposed_actions: list[ProposedAction]
    trace: list[TraceStep]
    graph: Graph
    meta: Meta


# ---- other responses -----------------------------------------------------------------
class ExecuteActionResponse(BaseModel):
    action_id: str
    type: str
    status: Literal["executed"]
    affected: list[str]
    graph_delta: dict[str, Any]
    audit_id: str
    report_url: str | None = None


class CaseSummary(BaseModel):
    id: str
    title: str
    alert: str
    status: str
    seed_accounts: list[str]
    created_at: str
    suggested_questions: list[str]


class AuditEntry(BaseModel):
    id: str
    type: str
    label: str
    created_at: str
    account_ids: list[str]
    affected: list[str]
    evidence_refs: list[str]


class InvestigationSummary(BaseModel):
    id: str
    question: str
    created_at: str
    conclusion: str
    mode: str
    summary: str


class CaseDetail(CaseSummary):
    investigations: list[InvestigationSummary]
    audit_trail: list[AuditEntry]
    latest_investigation: InvestigateResponse | None


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    db: Literal["ok", "unreachable"]
    llm: Literal["configured", "not_configured"]
    llm_model: str | None
    graph: dict[str, int] | None
    capabilities: dict[str, bool] | None
    version: str


class ErrorBody(BaseModel):
    code: str
    message: str
    detail: dict[str, Any] = {}


class ErrorResponse(BaseModel):
    error: ErrorBody
