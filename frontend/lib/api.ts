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
