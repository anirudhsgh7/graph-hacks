// Presentation logic for an investigation: how each tool step is named, which graph
// algorithm it ran, the headline numbers, the order the graph "assembles" in, and the
// account / evidence links inside the summary. Pure functions over the API contract.

import type { Evidence, Finding, InvestigationResponse, TraceStep } from "@/lib/types";

// ---- tool steps ----------------------------------------------------------------------------

export interface ToolMeta {
  /** What the agent is doing, in plain words. */
  label: string;
  /** The FalkorDB mechanism behind it (the "proof" badge). */
  algorithm: string;
  /** Icon key (components/Icons.tsx). */
  icon: IconKey;
}

export type IconKey =
  | "profile"
  | "link"
  | "ring"
  | "layers"
  | "trail"
  | "flow"
  | "cut"
  | "flask"
  | "rank"
  | "search"
  | "ban";

export const TOOL_META: Record<string, ToolMeta> = {
  account_profile: { label: "Profile the account", algorithm: "Cypher", icon: "profile" },
  shared_infrastructure: { label: "Pivot on shared phones & IPs", algorithm: "2-hop Cypher", icon: "link" },
  detect_ring: { label: "Test for a mule ring", algorithm: "algo.WCC", icon: "ring" },
  layering_scan: { label: "Scan for pass-through money", algorithm: "temporal Cypher", icon: "layers" },
  money_trail: { label: "Trace the money", algorithm: "algo.SPpaths", icon: "trail" },
  follow_funds: { label: "Follow the payment", algorithm: "temporal Cypher", icon: "trail" },
  laundering_capacity: { label: "Measure laundering capacity", algorithm: "max-flow", icon: "flow" },
  plan_minimum_freeze: { label: "Find the smallest freeze", algorithm: "min-cut · GRAPH.COPY", icon: "cut" },
  simulate_freeze: { label: "Simulate a freeze", algorithm: "GRAPH.COPY what-if", icon: "flask" },
  rank_hubs: { label: "Rank collector accounts", algorithm: "algo.pageRank", icon: "rank" },
  search_accounts: { label: "Search accounts", algorithm: "Cypher", icon: "search" },
};

export function toolMeta(tool: string): ToolMeta {
  return TOOL_META[tool] ?? { label: tool.replace(/_/g, " "), algorithm: "Cypher", icon: "search" };
}

/** A step as the live timeline shows it (streamed: may still be running). */
export interface LiveStep {
  step: number;
  tool: string;
  status: "started" | "done";
  ok?: boolean;
  headline?: string;
  duration_ms?: number;
  evidence_ids?: string[];
}

export function stepsFromTrace(trace: TraceStep[]): LiveStep[] {
  return trace.map((t) => ({
    step: t.step,
    tool: t.tool,
    status: "done",
    ok: t.ok,
    headline: t.headline,
    duration_ms: t.duration_ms,
    evidence_ids: t.evidence_ids,
  }));
}

// ---- assembling the graph in the order the agent found things --------------------------------

/** Node ids visible after each step (cumulative). Index k = after step k+1. */
export function revealFrames(resp: InvestigationResponse, seeds: string[]): string[][] {
  const byId = new Map(resp.evidence.map((e) => [e.id, e]));
  const inGraph = new Set(resp.graph.nodes.map((n) => n.id));
  const shown = new Set(seeds.filter((s) => inGraph.has(s)));
  const frames: string[][] = [];
  for (const t of resp.trace) {
    for (const ref of t.evidence_ids) {
      for (const id of byId.get(ref)?.node_ids ?? []) if (inGraph.has(id)) shown.add(id);
    }
    frames.push([...shown]);
  }
  return frames;
}

// ---- headline numbers -------------------------------------------------------------------------

export interface Stat {
  key: string;
  value: number;
  /** How to print the value. */
  format: "money" | "int" | "minutes" | "rank";
  label: string;
  tone: "danger" | "accent" | "ok" | "info" | "neutral";
  evidenceId?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function latest(evidence: Evidence[], type: string): Evidence | undefined {
  return [...evidence].reverse().find((e) => e.type === type);
}

export function headlineStats(resp: InvestigationResponse): Stat[] {
  const ev = resp.evidence;
  const stats: Stat[] = [];
  const cap = latest(ev, "capacity");
  const plan = [...ev].reverse().find((e) => e.type === "freeze_plan" && list(e.result_excerpt.recommended).length > 0);
  const ring = ev.find((e) => e.type === "community" && e.result_excerpt.verdict === "mule_ring");
  const funds = ev.find((e) => e.type === "path" && e.tool === "follow_funds" && (num(e.result_excerpt.hops) ?? 0) >= 2);
  const strong = ev.filter((e) => e.type === "path" && e.tool === "money_trail" && e.result_excerpt.quality === "strong");

  if (resp.conclusion === "suspicious") {
    if (cap) {
      const hubs = list(cap.result_excerpt.hub_ids).join(" + ");
      const c = num(cap.result_excerpt.capacity) ?? 0;
      stats.push({
        key: "capacity",
        value: c,
        format: "money",
        label: c > 0 ? `can reach ${hubs || "the cash-out"}` : `can still reach ${hubs || "the cash-out"}`,
        tone: c > 0 ? "danger" : "ok",
        evidenceId: cap.id,
      });
    }
    if (ring) {
      stats.push({
        key: "ring",
        value: num(ring.result_excerpt.community_size) ?? 0,
        format: "int",
        label: "accounts in the ring",
        tone: "danger",
        evidenceId: ring.id,
      });
    }
    if (plan) {
      stats.push({
        key: "freeze",
        value: list(plan.result_excerpt.recommended).length,
        format: "int",
        label: list(plan.result_excerpt.recommended).length === 1 ? "freeze stops it" : "freezes stop it",
        tone: "accent",
        evidenceId: plan.id,
      });
    }
    if (funds) {
      stats.push({
        key: "minutes",
        value: num(funds.result_excerpt.minutes_total) ?? 0,
        format: "minutes",
        label: "for the money to cross",
        tone: "neutral",
        evidenceId: funds.id,
      });
    } else if (strong.length) {
      const fastest = strong.reduce((a, b) =>
        (num(a.result_excerpt.minutes_total) ?? 1e9) <= (num(b.result_excerpt.minutes_total) ?? 1e9) ? a : b,
      );
      stats.push({
        key: "minutes",
        value: num(fastest.result_excerpt.minutes_total) ?? 0,
        format: "minutes",
        label: "for the money to cross",
        tone: "neutral",
        evidenceId: fastest.id,
      });
    }
    if (!plan && resp.meta.frozen_accounts.length > 0) {
      stats.push({
        key: "frozen",
        value: resp.meta.frozen_accounts.length,
        format: "int",
        label: "accounts frozen",
        tone: "ok",
      });
    }
    return stats.slice(0, 4);
  }

  // No evidence: show why it is *not* laundering.
  const profile = ev.find((e) => e.type === "profile");
  const pattern = latest(ev, "pattern");
  const community = ev.find((e) => e.type === "community");
  if (profile && num(profile.result_excerpt.anomaly_rank) !== null && (num(profile.result_excerpt.anomaly_top_pct) ?? 100) <= 5) {
    stats.push({
      key: "rank",
      value: num(profile.result_excerpt.anomaly_rank)!,
      format: "rank",
      label: "legacy anomaly score — explained",
      tone: "info",
      evidenceId: profile.id,
    });
  }
  if (community) {
    const shared = (num(community.result_excerpt.shared_devices) ?? 0) + (num(community.result_excerpt.shared_ips) ?? 0);
    if (community.result_excerpt.verdict === "shared_infrastructure_only") {
      stats.push({
        key: "pass",
        value: Math.round(100 * (num(community.result_excerpt.pass_through_ratio) ?? 0)),
        format: "int",
        label: "% passed on (rings: 85%+)",
        tone: "info",
        evidenceId: community.id,
      });
    } else {
      stats.push({ key: "shared", value: shared, format: "int", label: "shared devices or IPs", tone: "info", evidenceId: community.id });
    }
  }
  if (pattern) {
    stats.push({
      key: "layering",
      value: num(pattern.result_excerpt.pass_through_patterns) ?? 0,
      format: "int",
      label: "pass-through transfers",
      tone: "info",
      evidenceId: pattern.id,
    });
  }
  stats.push({ key: "checks", value: resp.trace.length, format: "int", label: "graph checks run", tone: "neutral" });
  return stats.slice(0, 4);
}

export function formatStat(s: Stat, value = s.value): string {
  switch (s.format) {
    case "money":
      return `$${Math.round(value).toLocaleString("en-US")}`;
    case "minutes":
      return `${Math.round(value)} min`;
    case "rank":
      return `#${Math.round(value)}`;
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

// ---- summary text with account chips and evidence markers -----------------------------------

export type SummaryPart =
  | { kind: "text"; text: string }
  | { kind: "account"; id: string }
  | { kind: "money"; text: string; evidenceId: string | null };

const TOKEN = /\b([ACHMX]\d{1,3})\b|\$([\d,]+(?:\.\d+)?)/g;

/** Splits the summary so account ids become chips and dollar amounts link to the evidence
 * that measured them (matched by value, never guessed from wording). */
export function summaryParts(summary: string, evidence: Evidence[], knownAccounts: Set<string>): SummaryPart[] {
  const parts: SummaryPart[] = [];
  let last = 0;
  for (const m of summary.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: summary.slice(last, at) });
    if (m[1] && knownAccounts.has(m[1])) {
      parts.push({ kind: "account", id: m[1] });
    } else if (m[2]) {
      const value = Number(m[2].replace(/,/g, ""));
      parts.push({ kind: "money", text: m[0], evidenceId: evidenceWithValue(evidence, value) });
    } else {
      parts.push({ kind: "text", text: m[0] });
    }
    last = at + m[0].length;
  }
  if (last < summary.length) parts.push({ kind: "text", text: summary.slice(last) });
  return parts;
}

function evidenceWithValue(evidence: Evidence[], value: number): string | null {
  for (const e of evidence) {
    for (const v of Object.values(e.result_excerpt)) {
      if (typeof v === "number" && Math.abs(v - value) < 0.51) return e.id;
    }
  }
  return null;
}

// ---- findings ---------------------------------------------------------------------------------

const FINDING_ICON: Record<string, IconKey> = {
  community: "ring",
  path: "trail",
  capacity: "flow",
  freeze_plan: "cut",
  simulation: "flask",
  profile: "profile",
  pattern: "layers",
  shared_entities: "link",
  no_path: "ban",
  ranking: "rank",
};

export function findingIcon(f: Finding, evidence: Evidence[]): IconKey {
  const first = evidence.find((e) => e.id === f.evidence_refs[0]);
  return (first && FINDING_ICON[first.type]) || "search";
}

/** The number that matters in a finding title ("$30,100", "7 accounts", "36 minutes"). */
export function findingKeyFigure(f: Finding): string | null {
  const money = f.title.match(/\$[\d,]+/);
  if (money) return money[0];
  const count = f.title.match(/(\d+)\s+(accounts?|hops?|minutes?)/);
  if (count) return `${count[1]} ${count[2].replace(/s$/, "")}${Number(count[1]) === 1 ? "" : "s"}`;
  const pct = f.title.match(/(\d+)%/);
  return pct ? pct[0] : null;
}
