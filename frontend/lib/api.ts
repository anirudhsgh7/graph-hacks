// API client for the investigation console.
//
// Modes:
//   NEXT_PUBLIC_API_BASE_URL=mock            -> frozen fixtures in lib/mocks (default; no backend needed)
//   NEXT_PUBLIC_API_BASE_URL=http://host:8000 -> live FastAPI backend (backend/docs/api-contract.md)
//
// Mutating calls send `Authorization: Bearer <token>` when NEXT_PUBLIC_BACKEND_API_TOKEN
// is set (the backend requires it only when its own BACKEND_API_TOKEN is configured).

import type {
  ApiErrorBody,
  CaseDetail,
  CaseSummary,
  ExecuteActionResponse,
  GraphPayload,
  HealthResponse,
  InvestigationResponse,
} from "@/lib/types";
import { mockCaseDetail, mockCases, mockSnapshot, pickInvestigation, recordExecution } from "@/lib/mocks";

const RAW = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "mock").trim();
export const API_BASE = RAW;
export const IS_MOCK = RAW === "" || RAW === "mock";

const API_TOKEN = (process.env.NEXT_PUBLIC_BACKEND_API_TOKEN ?? "").trim();
const authHeaders = (): Record<string, string> =>
  API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};

export class ApiError extends Error {
  code: string;
  detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 45000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        // non-JSON error body — fall through to the generic message
      }
      throw new ApiError(
        body?.error?.code ?? `HTTP_${res.status}`,
        body?.error?.message ?? `Request failed with status ${res.status}.`,
        body?.error?.detail,
      );
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError("CLIENT_TIMEOUT", `Request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw new ApiError(
      "BACKEND_UNREACHABLE",
      "Cannot reach the backend. If it is on free hosting it may be waking up — retry in about a minute.",
    );
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function investigate(question: string, caseId: string): Promise<InvestigationResponse> {
  if (IS_MOCK) {
    await sleep(1100); // keep the loading state honest in demos
    return pickInvestigation(caseId, question);
  }
  return request<InvestigationResponse>("/api/investigate", {
    method: "POST",
    body: JSON.stringify({ question, case_id: caseId }),
  });
}

/** One agent step as it happens (POST /api/investigate/stream "step" events). */
export interface StreamStep {
  step: number;
  tool: string;
  status: "started" | "done";
  ok?: boolean;
  headline?: string;
  duration_ms?: number;
  evidence_ids?: string[];
}

/**
 * Investigate while reporting each tool step as it runs.
 * Live: reads the backend's Server-Sent Events. Mock: replays the recorded trace at a
 * readable pace. Falls back to the plain request if streaming is not available.
 */
export async function investigateStream(
  question: string,
  caseId: string,
  onStep: (s: StreamStep) => void,
): Promise<InvestigationResponse> {
  if (IS_MOCK) {
    const resp = pickInvestigation(caseId, question);
    await sleep(350);
    for (const t of resp.trace) {
      onStep({ step: t.step, tool: t.tool, status: "started" });
      await sleep(320 + Math.min(260, t.duration_ms));
      onStep({ step: t.step, tool: t.tool, status: "done", ok: t.ok, headline: t.headline,
               duration_ms: t.duration_ms, evidence_ids: t.evidence_ids });
    }
    await sleep(250);
    return resp;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/investigate/stream`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ question, case_id: caseId }),
    });
  } catch {
    return investigate(question, caseId);
  }
  if (!res.ok || !res.body) {
    if (res.status === 404 || !res.body) return investigate(question, caseId);
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      // non-JSON error
    }
    throw new ApiError(body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? `Request failed (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Display pacing: a fast run (rule-based ≈ 1 s) would flash past, so steps are shown at
  // least STEP_GAP_MS apart. Only the timeline is paced; meta.latency_ms stays the real figure.
  const STEP_GAP_MS = 220;
  let lastEmit = 0;
  const paced = async (s: StreamStep) => {
    const wait = lastEmit + STEP_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastEmit = Date.now();
    onStep(s);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue; // keep-alive comment
      const payload = JSON.parse(data.join("\n"));
      if (event === "step") await paced(payload as StreamStep);
      else if (event === "done") return payload as InvestigationResponse;
      else if (event === "error") throw new ApiError(payload.code ?? "INTERNAL", payload.message ?? "Investigation failed.");
    }
  }
  throw new ApiError("STREAM_ENDED", "The investigation stream ended before an answer arrived. Retry.");
}

export interface ExecuteMeta {
  type: string;
  account_ids: string[];
  case_id?: string | null;
}

export async function executeAction(
  actionId: string,
  confirm = true,
  meta?: ExecuteMeta,
): Promise<ExecuteActionResponse> {
  if (IS_MOCK) {
    await sleep(600);
    return recordExecution(actionId, meta);
  }
  return request<ExecuteActionResponse>("/api/actions/execute", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ action_id: actionId, confirm, case_id: meta?.case_id ?? undefined }),
  });
}

export async function graphSnapshot(caseId: string): Promise<GraphPayload> {
  if (IS_MOCK) {
    await sleep(150);
    return mockSnapshot(caseId);
  }
  return request<GraphPayload>(`/api/graph/snapshot?case_id=${encodeURIComponent(caseId)}`);
}

export async function fetchCases(): Promise<CaseSummary[]> {
  if (IS_MOCK) {
    await sleep(150);
    return mockCases;
  }
  return request<CaseSummary[]>("/api/cases");
}

export async function fetchCase(caseId: string): Promise<CaseDetail> {
  if (IS_MOCK) {
    await sleep(150);
    return mockCaseDetail(caseId);
  }
  return request<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);
}

export type HealthMode = "checking" | "mock" | "ok" | "degraded" | "down";

export interface HealthState {
  mode: HealthMode;
  db?: string;
  llm?: string;
  llm_model?: string | null;
  accounts?: number;
  transfers?: number;
  version?: string;
}

export async function health(): Promise<HealthState> {
  if (IS_MOCK) return { mode: "mock" };
  try {
    const r = await request<HealthResponse>("/api/health", undefined, 8000);
    return {
      mode: r.status === "ok" ? "ok" : "degraded",
      db: r.db,
      llm: r.llm,
      llm_model: r.llm_model,
      accounts: r.graph?.accounts,
      transfers: r.graph?.transfers,
      version: r.version,
    };
  } catch {
    return { mode: "down" };
  }
}
