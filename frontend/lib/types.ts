// API contract types — mirror plan.md §6 (v1, frozen 2026-10-15).
// The frontend consumes only these shapes; the backend (FastAPI) produces them.

export type InvestigationStatus = "complete" | "partial" | "no_evidence";

export interface Evidence {
  id: string;
  type: "path" | "community" | "shared_entities" | "pattern" | "algorithm";
  tool: string;
  node_ids: string[];
  edge_ids: string[];
  result_excerpt: Record<string, unknown>;
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
}

export interface ProposedAction {
  id: string;
  /** e.g. "freeze_accounts" | "export_case_report" | "dismiss_alert" */
  type: string;
  label: string;
  requires_confirmation: boolean;
  evidence_refs: string[];
  simulation?: SimulationPreview;
}

export interface TraceStep {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  rows: number;
  duration_ms: number;
}

export interface GraphNode {
  id: string;
  /** "Account" | "Device" | "IPAddress" */
  label: string;
  status?: "active" | "flagged" | "frozen";
  anomaly_score?: number;
  /** 0..1 relative canvas position (makes demo layouts deterministic) */
  x_hint?: number;
  y_hint?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  /** "TRANSFER" | "USED_DEVICE" | "USED_IP" */
  type: string;
  amount?: number;
  ts?: string;
}

export interface GraphHighlight {
  paths?: string[][];
  communities?: string[][];
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  highlight?: GraphHighlight;
}

export interface InvestigationMeta {
  model?: string;
  tool_iterations?: number;
  latency_ms?: number;
}

export interface InvestigationResponse {
  case_id: string;
  status: InvestigationStatus;
  summary: string;
  findings: Finding[];
  evidence: Evidence[];
  proposed_actions: ProposedAction[];
  trace: TraceStep[];
  graph: GraphPayload;
  meta?: InvestigationMeta;
}

export interface ExecuteActionResponse {
  action_id: string;
  status: "executed" | "failed";
  executed_at: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export interface CaseStateResponse {
  case_id: string;
  questions: { question: string; asked_at: string }[];
}
