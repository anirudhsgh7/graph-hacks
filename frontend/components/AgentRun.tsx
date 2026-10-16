"use client";

// The agent, visibly at work.
//   LiveTimeline - while the investigation runs: each graph step appears as it happens.
//   ProofStrip   - afterwards: the same steps as a strip with the FalkorDB algorithm behind
//                  each one; click a step to light up its evidence; replay re-assembles the graph.

import { useEffect, useRef } from "react";
import AgentTrace from "@/components/AgentTrace";
import { StepIcon } from "@/components/Icons";
import { toolMeta, type LiveStep } from "@/lib/agentRun";
import type { TraceStep } from "@/lib/types";

function Spinner() {
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
}

export function LiveTimeline({ steps, elapsedMs, question }: { steps: LiveStep[]; elapsedMs: number; question: string }) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <section aria-live="polite" className="agent-live overflow-hidden rounded-xl border border-accent-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-accent-line px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-fill opacity-70" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-fill" />
          </span>
          <span className="text-[13px] font-semibold text-ink">Agent investigating on the graph</span>
          <span className="hidden text-[12px] text-muted sm:inline">“{question}”</span>
        </div>
        <span className="font-mono text-[12px] tabular-nums text-accent">
          {done} step{done === 1 ? "" : "s"} · {(elapsedMs / 1000).toFixed(1)}s
        </span>
      </div>
      <ol className="px-4 py-3">
        {steps.length === 0 && (
          <li className="flex items-center gap-3 py-1.5 text-[13px] text-muted">
            <Spinner /> Reading the case and planning the first query…
          </li>
        )}
        {steps.map((s) => {
          const m = toolMeta(s.tool);
          const running = s.status === "started";
          return (
            <li key={s.step} className="step-in flex items-start gap-3 py-1.5">
              <span
                className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${
                  running ? "border-accent-line bg-accent-soft text-accent" : s.ok === false ? "border-danger-line text-danger" : "border-line bg-surface text-ink"
                }`}
              >
                {running ? <Spinner /> : <StepIcon name={m.icon} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-[13px] font-medium text-ink">{m.label}</span>
                  <span className="algo-badge">{m.algorithm}</span>
                </div>
                <div className={`text-[12.5px] ${running ? "text-faint" : s.ok === false ? "text-danger" : "text-muted"}`}>
                  {running ? "running…" : s.headline}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function ProofStrip({
  trace,
  activeStep,
  playing,
  onSelectStep,
  onReplay,
}: {
  trace: TraceStep[];
  /** Step being revealed (replay) or selected; null = none. */
  activeStep: number | null;
  playing: boolean;
  onSelectStep: (step: number | null) => void;
  onReplay: () => void;
}) {
  const scroller = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (activeStep == null || !scroller.current) return;
    const box = scroller.current;
    const el = box.querySelector<HTMLElement>(`[data-step="${activeStep}"]`);
    // scroll the strip sideways only — never the page
    if (el) box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.clientWidth) / 2, behavior: "smooth" });
  }, [activeStep]);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">How the agent got there · {trace.length} graph steps</h2>
        <button type="button" className="chip h-7 px-2.5 text-[11.5px] text-ink" onClick={onReplay} disabled={playing}>
          {playing ? "assembling…" : "▶ replay on the graph"}
        </button>
      </div>
      <ol ref={scroller} className="relative -mx-1 mt-2.5 flex snap-x gap-2 overflow-x-auto px-1 pb-2">
        {trace.map((t, i) => {
          const m = toolMeta(t.tool);
          const active = activeStep === t.step;
          return (
            <li key={t.step} data-step={t.step} className="snap-start">
              <button
                type="button"
                onClick={() => onSelectStep(active ? null : t.step)}
                className={`proof-step group flex h-full w-[220px] flex-col rounded-xl border p-3 text-left transition ${
                  active ? "border-accent-line bg-accent-soft" : "border-line bg-surface hover:border-line-strong"
                }`}
                aria-pressed={active}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[11px] tabular-nums text-faint">{String(i + 1).padStart(2, "0")}</span>
                  <span className={active ? "text-accent" : "text-muted group-hover:text-ink"}>
                    <StepIcon name={m.icon} />
                  </span>
                  <span className={`badge ml-auto ${t.ok ? "badge-ok" : "badge-danger"}`}>{t.ok ? "ok" : "failed"}</span>
                </div>
                <div className="mt-2 text-[12.5px] font-medium leading-snug text-ink">{m.label}</div>
                <div className="mt-1 text-[12px] leading-snug text-muted">{t.headline}</div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-2.5">
                  <span className="algo-badge">{m.algorithm}</span>
                  <span className="font-mono text-[10.5px] tabular-nums text-faint">{t.duration_ms} ms</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
      <details className="mt-1">
        <summary className="cursor-pointer select-none text-[12px] text-faint transition hover:text-muted">
          Technical trace (tool arguments, rows, evidence ids)
        </summary>
        <AgentTrace trace={trace} />
      </details>
    </section>
  );
}
