// API contract types — mirror backend/docs/api-contract.md (v1.1, delivered 2026-10-16).
// The backend/fastAPI app produces these shapes (backend/openapi.json is the
// machine-readable version); the frontend consumes only these.

export type InvestigationStatus = "complete" | "no_evidence" | "partial";
export type Conclusion = "suspicious" | "no_evidence" | "inconclusive";

export type EvidenceType =
  | "profile"
  | "shared_entities"
  | "community"
  | "path"
  | "no_path"
  | "pattern"
  | "ranking"
  | "capacity"
  | "simulation"
  | "freeze_plan";

export type ActionType = "freeze_accounts" | "flag_accounts" | "clear_alert" | "export_case_report";

/** A named query + parameters behind one piece of evidence; the Cypher is replayable. */
export interface Receipt {
  query: string;
  params: Record<string, unknown>;
  cypher: string;
}

export interface Evidence {
  id: string;
  type: EvidenceType;
  tool: string;
  node_ids: string[];
  edge_ids: string[];
  result_excerpt: Record<string, unknown>;
  receipts: Receipt[];
}

export interface Finding {
  id: string;
  title: string;
  detail: string;
  /** 0..1 */
  confidence: number;
  evidence_refs: string[];
}

export interface SimulationPreview {
  capacity_before: number;
  capacity_after: number;
  residual_routes: string[][];
  remaining_paths?: number | null;
  /** "fork" = proven on a GRAPH.COPY copy; "python" = computed by the solver. */
  verified_on: string;
}

export interface ProposedAction {
  id: string;
  type: ActionType;
  label: string;
  account_ids: string[];
  requires_confirmation: boolean;
  evidence_refs: string[];
  simulation?: SimulationPreview | null;
}

export interface TraceStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  rows: number;
  duration_ms: number;
  /** One-line human summary of what the tool found. */
  headline: string;
  evidence_ids: string[];
  error?: string | null;
}

export interface GraphNode {
  id: string;
  /** "Account" | "Device" | "IPAddress" */
  label: string;
  /** Account type (personal / business / merchant / external) when label = Account. */
  type?: string | null;
  /** Device kind when label = Device. */
  kind?: string | null;
  status?: "active" | "flagged" | "frozen" | string | null;
  anomaly_score?: number | null;
  /** 0..1 relative canvas position — set for the main money path (left → right). */
  x_hint?: number | null;
  y_hint?: number | null;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** "TRANSFER" | "USED_DEVICE" | "USED_IP" */
  type: string;
  amount?: number | null;
  ts?: string | null;
  channel?: string | null;
}

export interface GraphHighlight {
  paths?: string[][];
  communities?: string[][];
  infrastructure_clusters?: string[][];
  /** Accounts whose freeze cuts every route (minimum cut). */
  freeze_plan?: string[];
  /** Ordered account pairs carrying the max-flow (flow arrows). */
  flows?: string[][];
  /** Accounts frozen by the analyst. */
  frozen?: string[];
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlight?: GraphHighlight;
}

export interface InvestigationMeta {
  mode: "llm" | "rule_based";
  model?: string | null;
  narrative_source: "llm" | "deterministic";
  tool_iterations: number;
  latency_ms: number;
  maxflow_engine: "falkordb" | "python";
  frozen_accounts: string[];
  /** e.g. "LLM_UNAVAILABLE: ..." when the investigation fell back. */
  notes: string[];
}

export interface InvestigationResponse {
  investigation_id: string;
  case_id: string | null;
  question: string;
  created_at: string;
  status: InvestigationStatus;
  conclusion: Conclusion;
  summary: string;
  findings: Finding[];
  evidence: Evidence[];
  proposed_actions: ProposedAction[];
  trace: TraceStep[];
  graph: GraphPayload;
  meta: InvestigationMeta;
}

export interface GraphDelta {
  nodes: { id: string; status: string }[];
  case: { id: string; status: string } | null;
}

export interface ExecuteActionResponse {
  action_id: string;
  type: string;
  status: "executed";
  affected: string[];
  graph_delta: GraphDelta;
  audit_id: string;
  /** Present for export_case_report: path on the backend, e.g. /api/cases/case-001/report */
  report_url?: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

// ---- cases (console + case store) --------------------------------------------------

export interface CaseSummary {
  id: string;
  title: string;
  alert: string;
  status: string;
  seed_accounts: string[];
  created_at: string;
  suggested_questions: string[];
}

export interface AuditEntry {
  id: string;
  type: string;
  label: string;
  created_at: string;
  account_ids: string[];
  affected: string[];
  evidence_refs: string[];
}

export interface InvestigationSummary {
  id: string;
  question: string;
  created_at: string;
  conclusion: string;
  mode: string;
  summary: string;
}

export interface CaseDetail extends CaseSummary {
  investigations: InvestigationSummary[];
  audit_trail: AuditEntry[];
  latest_investigation: InvestigationResponse | null;
}

// ---- health ------------------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degraded";
  db: "ok" | "unreachable";
  llm: "configured" | "not_configured";
  llm_model?: string | null;
  graph?: { accounts: number; transfers: number } | null;
  capabilities?: Record<string, boolean> | null;
  version: string;
}
