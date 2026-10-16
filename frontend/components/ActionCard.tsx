"use client";

import { useState } from "react";
import { API_BASE, ApiError, executeAction } from "@/lib/api";
import { CheckIcon } from "@/components/Icons";
import { formatMoney } from "@/lib/format";
import type { ExecuteActionResponse, ProposedAction } from "@/lib/types";

type ActionState = "idle" | "executing" | "executed" | "error";

export default function ActionCard({
  action,
  caseId,
  onSelectEvidence,
  onExecuted,
}: {
  action: ProposedAction;
  caseId: string;
  onSelectEvidence: (id: string) => void;
  onExecuted?: (result: ExecuteActionResponse) => void;
}) {
  const [state, setState] = useState<ActionState>("idle");
  const [result, setResult] = useState<ExecuteActionResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const sim = action.simulation;
  const executed = state === "executed";

  const reportHref = result?.report_url
    ? result.report_url.startsWith("http")
      ? result.report_url
      : `${API_BASE}${result.report_url}`
    : null;

  return (
    <div className={`rounded-lg p-3.5 ${executed ? "bg-ok-soft" : "bg-raised"}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium leading-5 text-ink">{action.label}</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wide text-faint">{action.type}</div>
        </div>
        <span className={`badge shrink-0 ${executed ? "badge-ok" : "badge-neutral"}`}>
          {executed ? "executed" : action.requires_confirmation ? "needs confirmation" : "one click"}
        </span>
      </div>

      {sim && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
            {executed ? "Impact on the live graph" : "Simulated impact (computed on the graph)"}
          </div>
          {/* One bar that drains from today's capacity to the post-freeze value on confirm. */}
          <Bar
            label={executed ? "capacity now" : "can move today"}
            value={executed ? sim.capacity_after : sim.capacity_before}
            max={Math.max(sim.capacity_before, 1)}
            tone={executed ? "bg-ok" : "bg-danger"}
          />
          {!executed && (
            <Bar label="if you confirm" value={sim.capacity_after} max={Math.max(sim.capacity_before, 1)} tone="bg-ok" />
          )}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-0.5 text-[11px]">
            {sim.residual_routes.length > 0 ? (
              <span className="text-accent">
                residual route: {sim.residual_routes.map((r) => r.join(" → ")).join(" · ")}
              </span>
            ) : (
              <span className="text-muted">
                {sim.remaining_paths != null
                  ? `${sim.remaining_paths} route${sim.remaining_paths === 1 ? "" : "s"} left`
                  : "no route remains"}
              </span>
            )}
            <span className="text-faint">
              {sim.verified_on === "fork" ? "proven on a graph copy" : `verified (${sim.verified_on})`}
            </span>
          </div>
        </div>
      )}

      {executed && result && result.affected.length > 0 && (
        <div className="freeze-banner mt-3 flex items-center gap-2 text-[12.5px] text-ink">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-ok text-surface">
            <CheckIcon className="h-3 w-3" />
          </span>
          {action.type === "freeze_accounts" ? (
            <span>
              Route cut — <b className="font-mono">{result.affected.join(" + ")}</b> frozen
              {sim?.verified_on === "fork" && <span className="text-muted"> · verified on a copy of the graph</span>}
            </span>
          ) : (
            <span>
              {action.type === "flag_accounts" ? "Flagged" : "Done"}: <b className="font-mono">{result.affected.join(", ")}</b>
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {action.evidence_refs.map((ref) => (
            <button
              key={ref}
              type="button"
              className="rounded-full border border-line px-2 py-[3px] font-mono text-[10.5px] leading-4 text-faint transition hover:border-accent-line hover:text-accent"
              onClick={() => onSelectEvidence(ref)}
            >
              {ref}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          {reportHref && (
            <a
              href={reportHref}
              target="_blank"
              rel="noreferrer"
              className="text-[12px] font-medium text-accent hover:underline"
            >
              Open report →
            </a>
          )}
          <button
            type="button"
            className={`btn ${executed ? "" : "btn-primary"}`}
            disabled={state === "executing" || executed}
            onClick={async () => {
              setState("executing");
              setErrorMessage(null);
              try {
                const res = await executeAction(action.id, true, {
                  type: action.type,
                  account_ids: action.account_ids,
                  case_id: caseId,
                });
                setResult(res);
                setState("executed");
                onExecuted?.(res);
              } catch (e) {
                setState("error");
                setErrorMessage(
                  e instanceof ApiError ? `${e.code} — ${e.message}` : "Action failed — try again.",
                );
              }
            }}
          >
            {executed ? "Done" : state === "executing" ? "Executing…" : action.requires_confirmation ? "Confirm" : "Run"}
          </button>
        </div>
      </div>
      {state === "error" && errorMessage && <div className="mt-2 text-xs text-danger">{errorMessage}</div>}
    </div>
  );
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const pct = Math.max(1.5, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted">
      <span className="w-28 shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
        <div className={`h-full rounded-full transition-[width,background-color] duration-[1400ms] ease-out ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right font-mono tabular-nums">{formatMoney(value)}</span>
    </div>
  );
}
