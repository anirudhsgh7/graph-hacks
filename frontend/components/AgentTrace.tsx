import type { TraceStep } from "@/lib/types";

export default function AgentTrace({ trace }: { trace: TraceStep[] }) {
  if (trace.length === 0) {
    return <p className="mt-2 text-sm text-slate-500">No tool calls recorded for this investigation.</p>;
  }
  return (
    <ol className="mt-3 space-y-1.5">
      {trace.map((t) => (
        <li
          key={t.step}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs"
        >
          <span className="font-mono text-slate-500">{String(t.step).padStart(2, "0")}</span>
          <span className="font-mono text-amber-300/90">{t.tool}</span>
          <span className={`chip ${t.ok ? "border-emerald-500/40 text-emerald-300" : "border-rose-500/40 text-rose-300"}`}>
            {t.ok ? "ok" : "failed"}
          </span>
          <span className="text-slate-500">{t.rows} rows</span>
          <span className="text-slate-500">{t.duration_ms} ms</span>
          <details className="ml-auto w-full sm:w-auto">
            <summary className="cursor-pointer select-none text-slate-500 transition hover:text-slate-300">
              args
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-950/70 p-2 text-[11px] leading-relaxed text-slate-300">
              {JSON.stringify(t.args, null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
