// API client for the investigation console.
//
// Modes:
//   NEXT_PUBLIC_API_BASE_URL=mock            -> frozen fixtures in lib/mocks (default; no backend needed)
//   NEXT_PUBLIC_API_BASE_URL=http://host:8000 -> live FastAPI backend (see plan.md §6)

import type {
  ApiErrorBody,
  ExecuteActionResponse,
  GraphPayload,
  InvestigationResponse,
} from "@/lib/types";
import { mockResponses } from "@/lib/mocks";

const RAW = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "mock").trim();
export const API_BASE = RAW;
export const IS_MOCK = RAW === "" || RAW === "mock";

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
    await sleep(900); // keep the loading state honest in demos
    const base = mockResponses[caseId] ?? mockResponses["case-001"];
    return { ...base, case_id: caseId };
  }
  return request<InvestigationResponse>("/api/investigate", {
    method: "POST",
    body: JSON.stringify({ question, case_id: caseId }),
  });
}

export async function executeAction(actionId: string, confirm = true): Promise<ExecuteActionResponse> {
  if (IS_MOCK) {
    await sleep(500);
    return { action_id: actionId, status: "executed", executed_at: new Date().toISOString() };
  }
  return request<ExecuteActionResponse>("/api/actions/execute", {
    method: "POST",
    body: JSON.stringify({ action_id: actionId, confirm }),
  });
}

export async function graphSnapshot(caseId: string): Promise<GraphPayload> {
  if (IS_MOCK) {
    await sleep(150);
    return (mockResponses[caseId] ?? mockResponses["case-001"]).graph;
  }
  return request<GraphPayload>(`/api/graph/snapshot?case_id=${encodeURIComponent(caseId)}`);
}

export type HealthMode = "checking" | "mock" | "ok" | "down";

export interface HealthState {
  mode: HealthMode;
  db?: string;
  llm?: string;
}

export async function health(): Promise<HealthState> {
  if (IS_MOCK) return { mode: "mock" };
  try {
    const r = await request<{ status: string; db: string; llm: string }>("/api/health", undefined, 8000);
    return { mode: "ok", db: r.db, llm: r.llm };
  } catch {
    return { mode: "down" };
  }
}
