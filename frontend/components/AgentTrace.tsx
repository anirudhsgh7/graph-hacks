import type { TraceStep } from "@/lib/types";

export default function AgentTrace({ trace }: { trace: TraceStep[] }) {
  if (trace.length === 0) {
    return <p className="mt-2 text-sm text-muted">No tool calls recorded for this investigation.</p>;
  }
  return (
    <ol className="mt-1 divide-y divide-line">
      {trace.map((t) => (
        <li key={t.step} className="py-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="w-5 font-mono tabular-nums text-faint">{String(t.step).padStart(2, "0")}</span>
            <span className="font-mono text-ink">{t.tool}</span>
            <span className={`badge ${t.ok ? "badge-ok" : "badge-danger"}`}>{t.ok ? "ok" : "failed"}</span>
            <span className="min-w-0 text-muted">{t.headline}</span>
            <span className="font-mono tabular-nums text-faint">{t.rows} rows</span>
            <span className="font-mono tabular-nums text-faint">{t.duration_ms} ms</span>
            <details className="ml-auto w-full sm:w-auto">
              <summary className="cursor-pointer select-none text-faint transition hover:text-muted">
                args
              </summary>
              <div className="mt-1.5 space-y-1">
                <pre className="overflow-x-auto rounded-md border border-line bg-inset p-2 text-[11px] leading-relaxed text-muted">
                  {JSON.stringify(t.args, null, 2)}
                </pre>
                {t.evidence_ids.length > 0 && (
                  <div className="font-mono text-[10.5px] text-faint">
                    evidence: {t.evidence_ids.join(", ")}
                  </div>
                )}
              </div>
            </details>
          </div>
          {t.error && <div className="mt-1 pl-8 text-danger">{t.error}</div>}
        </li>
      ))}
    </ol>
  );
}
