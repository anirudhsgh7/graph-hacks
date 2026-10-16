"use client";

// The answer, first: verdict, the numbers that matter, and the agent's conclusion with
// account chips (hover/click lights the account in the graph) and evidence markers on
// every amount the graph measured.

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon } from "@/components/Icons";
import { formatStat, headlineStats, summaryParts, type Stat } from "@/lib/agentRun";
import { formatMoney } from "@/lib/format";
import type { Conclusion, InvestigationResponse } from "@/lib/types";

const LABEL: Record<Conclusion, string> = {
  suspicious: "suspicious activity",
  no_evidence: "no evidence of laundering",
  inconclusive: "inconclusive",
};
const BADGE: Record<Conclusion, string> = { suspicious: "badge-warn", no_evidence: "badge-info", inconclusive: "badge-neutral" };
const TONE: Record<Stat["tone"], string> = {
  danger: "text-danger",
  accent: "text-accent",
  ok: "text-ok",
  info: "text-info",
  neutral: "text-ink",
};

function useReducedMotion(): boolean {
  const [reduced] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  return reduced;
}

/** Counts from 0 to `target` once per `runKey`. */
function CountUp({ stat, runKey }: { stat: Stat; runKey: string }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? stat.value : 0);
  const raf = useRef(0);
  useEffect(() => {
    if (reduced) return;
    const t0 = performance.now();
    const dur = 900;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      setShown(stat.value * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [stat.value, runKey, reduced]);
  return <>{formatStat(stat, reduced ? stat.value : shown)}</>;
}

export interface FreezeOutcome {
  accounts: string[];
  before: number | null;
  after: number | null;
  verified: boolean;
}

export default function VerdictHero({
  response,
  onFocusAccount,
  onSelectEvidence,
  freeze,
}: {
  response: InvestigationResponse;
  onFocusAccount: (id: string | null, sticky: boolean) => void;
  onSelectEvidence: (id: string) => void;
  freeze: FreezeOutcome | null;
}) {
  const stats = useMemo(() => headlineStats(response), [response]);
  const accounts = useMemo(
    () => new Set(response.graph.nodes.filter((n) => n.label === "Account").map((n) => n.id)),
    [response],
  );
  const parts = useMemo(() => summaryParts(response.summary, response.evidence, accounts), [response, accounts]);
  const markers = useMemo(() => {
    const order: string[] = [];
    for (const p of parts) if (p.kind === "money" && p.evidenceId && !order.includes(p.evidenceId)) order.push(p.evidenceId);
    return order;
  }, [parts]);
  const c = response.conclusion;
  const runKey = response.investigation_id;

  return (
    <section className={`verdict-hero verdict-${c} relative overflow-hidden rounded-2xl border px-4 py-5 sm:px-6`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${BADGE[c]}`}>{LABEL[c]}</span>
        <p className="text-[12px] leading-snug text-muted">“{response.question}”</p>
      </div>

      {stats.length > 0 && (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          {stats.map((s) => {
            // after a freeze the investigation-time capacity is history: say so, dim it
            const past = !!freeze && s.key === "capacity";
            const label = past ? s.label.replace(/^can reach/, "could reach") + " before the freeze" : s.label;
            return (
              <div key={s.key} className={`stat-tile ${past ? "opacity-60" : ""}`}>
                <dt className="sr-only">{s.label}</dt>
                <dd>
                  <button
                    type="button"
                    disabled={!s.evidenceId}
                    onClick={() => s.evidenceId && onSelectEvidence(s.evidenceId)}
                    className="text-left disabled:cursor-default"
                    title={s.evidenceId ? "Show the evidence on the graph" : undefined}
                  >
                    <span
                      className={`block font-mono text-[28px] font-semibold leading-none tracking-tight tabular-nums sm:text-[34px] ${TONE[s.tone]} ${past ? "line-through decoration-2" : ""}`}
                    >
                      <CountUp stat={s} runKey={runKey} />
                    </span>
                    <span className="mt-1.5 block text-[12px] leading-snug text-muted">{label}</span>
                  </button>
                </dd>
              </div>
            );
          })}
        </dl>
      )}

      {freeze && (
        <div className="freeze-banner mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-ok-line bg-ok-soft px-3.5 py-2.5 text-[13px] text-ink">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-ok text-surface">
            <CheckIcon className="h-3.5 w-3.5" />
          </span>
          <span>
            Route cut — <b className="font-mono">{freeze.accounts.join(" + ")}</b> frozen
            {freeze.before != null && freeze.after != null && (
              <>
                {" "}· capacity <span className="font-mono">{formatMoney(freeze.before)}</span> →{" "}
                <span className="font-mono font-semibold text-ok">{formatMoney(freeze.after)}</span>
              </>
            )}
          </span>
          {freeze.verified && <span className="text-[12px] text-muted">verified on a copy of the graph</span>}
        </div>
      )}

      <h2 className="eyebrow mt-5">Agent conclusion</h2>
      <p className="mt-1.5 max-w-4xl text-[15px] leading-relaxed text-ink sm:text-[16px]">
        {parts.map((p, i) => {
          if (p.kind === "text") return <span key={i}>{p.text}</span>;
          if (p.kind === "account")
            return (
              <button
                key={i}
                type="button"
                className="acct-chip"
                onMouseEnter={() => onFocusAccount(p.id, false)}
                onMouseLeave={() => onFocusAccount(null, false)}
                onFocus={() => onFocusAccount(p.id, false)}
                onBlur={() => onFocusAccount(null, false)}
                onClick={() => onFocusAccount(p.id, true)}
              >
                {p.id}
              </button>
            );
          const n = p.evidenceId ? markers.indexOf(p.evidenceId) + 1 : 0;
          return (
            <span key={i} className="whitespace-nowrap font-medium">
              {p.text}
              {p.evidenceId && (
                <button
                  type="button"
                  className="ev-marker"
                  onClick={() => onSelectEvidence(p.evidenceId!)}
                  aria-label={`Evidence ${p.evidenceId}`}
                  title={`measured by ${p.evidenceId} — click to show it`}
                >
                  {n}
                </button>
              )}
            </span>
          );
        })}
      </p>

      {c === "no_evidence" && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-faint">
          A defensible no-evidence result — every check the agent ran is in the strip below.
        </p>
      )}
      {response.meta.notes.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {response.meta.notes.map((n) => (
            <li key={n} className="text-[11px] leading-relaxed text-faint">
              {n}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 font-mono text-[11px] text-faint tabular-nums">
        {[
          response.meta.model ?? response.meta.mode.replace("_", "-"),
          `${response.meta.tool_iterations} graph steps`,
          `${(response.meta.latency_ms / 1000).toFixed(1)}s`,
          ...(response.meta.frozen_accounts.length ? [`${response.meta.frozen_accounts.length} frozen`] : []),
        ].join("  ·  ")}
      </div>
    </section>
  );
}
