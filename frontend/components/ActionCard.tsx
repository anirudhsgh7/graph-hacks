"use client";

import { useState } from "react";
import { executeAction } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import type { ProposedAction } from "@/lib/types";

type ActionState = "idle" | "executing" | "executed" | "error";

export default function ActionCard({
  action,
  onSelectEvidence,
}: {
  action: ProposedAction;
  onSelectEvidence: (id: string) => void;
}) {
  const [state, setState] = useState<ActionState>("idle");
  const sim = action.simulation;
  const executed = state === "executed";

  return (
    <div className={`card ${executed ? "border-emerald-500/50" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-slate-100">{action.label}</div>
          <div className="mt-0.5 font-mono text-[11px] text-slate-500">{action.type}</div>
        </div>
        <span className={`chip shrink-0 ${executed ? "border-emerald-500/60 text-emerald-300" : ""}`}>
          {executed ? "executed" : action.requires_confirmation ? "needs confirmation" : "one click"}
        </span>
      </div>

      {sim && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[11px] uppercase tracking-wide text-slate-500">Simulated impact (computed on the graph)</div>
          <Bar label="capacity before" value={sim.capacity_before} max={Math.max(sim.capacity_before, 1)} tone="bg-slate-500" />
          <Bar label="after the action" value={sim.capacity_after} max={Math.max(sim.capacity_before, 1)} tone="bg-emerald-500" />
          {sim.residual_routes.length > 0 && (
            <div className="pt-0.5 text-[11px] text-amber-300/90">
              residual route: {sim.residual_routes.map((r) => r.join(" → ")).join(" · ")}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {action.evidence_refs.map((ref) => (
            <button
              key={ref}
              type="button"
              className="chip transition hover:border-amber-500/60 hover:text-amber-300"
              onClick={() => onSelectEvidence(ref)}
            >
              {ref}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`btn ${executed ? "" : "btn-primary"}`}
          disabled={state === "executing" || executed}
          onClick={async () => {
            setState("executing");
            try {
              await executeAction(action.id, true);
              setState("executed");
            } catch {
              setState("error");
            }
          }}
        >
          {executed ? "Done" : state === "executing" ? "Executing…" : action.requires_confirmation ? "Confirm" : "Run"}
        </button>
      </div>
      {state === "error" && <div className="mt-2 text-xs text-rose-300">Action failed — try again.</div>}
    </div>
  );
}

function Bar({ label, value, max, tone }: { label: string; value: number; max: number; tone: string }) {
  const pct = Math.max(2, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-400">
      <span className="w-28 shrink-0">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-slate-800">
        <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right font-mono">{formatMoney(value)}</span>
    </div>
  );
}
