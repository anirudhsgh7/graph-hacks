// Frozen mock fixtures for the scripted demo scenarios (see plan.md §5).
// These are real, contract-conformant responses recorded from the FastAPI
// backend (contract v1.1 — backend/docs/api-contract.md), so the UI runs
// end-to-end without a database. Keep them in sync with the backend.

import type {
  CaseDetail,
  CaseSummary,
  ExecuteActionResponse,
  GraphPayload,
  InvestigationResponse,
} from "@/lib/types";

import casesJson from "./cases.json";
import burst from "./investigate-case-001-burst.json";
import afterFreeze from "./investigate-case-001-after-freeze.json";
import complaint from "./investigate-case-002-complaint.json";
import falseAlarm from "./investigate-case-003-false-alarm.json";
import household from "./investigate-case-004-household.json";
import snapshotBefore from "./snapshot-case-001-before.json";

// ---- case board --------------------------------------------------------------------

export const mockCases: CaseSummary[] = casesJson as CaseSummary[];

export function caseMeta(id: string): CaseSummary {
  return (
    mockCases.find((c) => c.id === id) ?? {
      id,
      title: `Case ${id}`,
      alert: "No briefing available for this case yet.",
      status: "open",
      seed_accounts: [],
      created_at: "",
      suggested_questions: ["What do we know about this case so far?"],
    }
  );
}

// ---- investigate -------------------------------------------------------------------

const FIXTURES: Record<string, InvestigationResponse> = {
  "case-001": burst as unknown as InvestigationResponse,
  "case-002": complaint as unknown as InvestigationResponse,
  "case-003": falseAlarm as unknown as InvestigationResponse,
  "case-004": household as unknown as InvestigationResponse,
};

// Questions that ask what is left *after* a freeze get the post-freeze recording.
const AFTER_FREEZE_RE = /around (this|the) freeze|way around|bypass|evade|after the freeze/i;

// Mock-side state, mirroring what the backend would know:
// which cases have had a freeze executed, and per-node status overrides.
const frozenDone = new Set<string>();
const investigated = new Set<string>();
const statusOverrides: Record<string, Record<string, string>> = {};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function patchGraph(graph: GraphPayload, caseId: string): GraphPayload {
  const overrides = statusOverrides[caseId];
  if (!overrides) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (overrides[n.id] ? { ...n, status: overrides[n.id] } : n)),
  };
}

export function pickInvestigation(caseId: string, question: string): InvestigationResponse {
  investigated.add(caseId);
  const wantsAfterFreeze =
    caseId === "case-001" && (frozenDone.has("case-001") || AFTER_FREEZE_RE.test(question));
  const base = wantsAfterFreeze ? afterFreeze : FIXTURES[caseId] ?? burst;
  const out = clone(base) as unknown as InvestigationResponse;
  out.case_id = caseId || out.case_id;
  out.graph = patchGraph(out.graph, caseId);
  return out;
}

// ---- actions -----------------------------------------------------------------------

export interface ExecuteMeta {
  type: string;
  account_ids: string[];
  case_id?: string | null;
}

export function recordExecution(actionId: string, meta?: ExecuteMeta): ExecuteActionResponse {
  const type = meta?.type ?? "freeze_accounts";
  const ids = meta?.account_ids ?? [];
  const caseId = meta?.case_id ?? undefined;

  const nodes: { id: string; status: string }[] = [];
  let caseDelta: { id: string; status: string } | null = null;

  if (type === "freeze_accounts") {
    for (const id of ids) nodes.push({ id, status: "frozen" });
    if (caseId) {
      frozenDone.add(caseId);
      statusOverrides[caseId] = { ...statusOverrides[caseId] };
      for (const id of ids) statusOverrides[caseId][id] = "frozen";
    }
  } else if (type === "flag_accounts") {
    for (const id of ids) nodes.push({ id, status: "flagged" });
    if (caseId) {
      statusOverrides[caseId] = { ...statusOverrides[caseId] };
      for (const id of ids) statusOverrides[caseId][id] = "flagged";
    }
  } else if (type === "clear_alert" && caseId) {
    caseDelta = { id: caseId, status: "cleared" };
  }

  return {
    action_id: actionId,
    type,
    status: "executed",
    affected: ids,
    graph_delta: { nodes, case: caseDelta },
    audit_id: `aud-${Math.random().toString(36).slice(2, 10)}`,
    report_url: null,
  };
}

// ---- graph snapshot ----------------------------------------------------------------

export function mockSnapshot(caseId: string): GraphPayload {
  const base =
    caseId === "case-001" && !investigated.has("case-001")
      ? (snapshotBefore as unknown as GraphPayload)
      : (FIXTURES[caseId] ?? burst).graph;
  return patchGraph(clone(base), caseId);
}

// ---- cases -------------------------------------------------------------------------

export function mockCaseDetail(caseId: string): CaseDetail {
  return {
    ...caseMeta(caseId),
    investigations: [],
    audit_trail: [],
    latest_investigation: null,
  };
}
