"use client";

import type { Evidence, Finding } from "@/lib/types";
import { formatPct } from "@/lib/format";

interface Props {
  findings: Finding[];
  evidence: Evidence[];
  selectedFindingId: string | null;
  selectedEvidenceId: string | null;
  onSelectFinding: (id: string) => void;
  onSelectEvidence: (id: string) => void;
}

export default function FindingsPanel({
  findings,
  evidence,
  selectedFindingId,
  selectedEvidenceId,
  onSelectFinding,
  onSelectEvidence,
}: Props) {
  if (findings.length === 0) return null;
  return (
    <div className="card">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Findings</h2>
      <ul className="mt-3 space-y-2">
        {findings.map((f) => {
          const selected = f.id === selectedFindingId;
          return (
            <li
              key={f.id}
              className={`rounded-lg border p-3 transition ${
                selected ? "border-amber-500/60 bg-amber-500/5" : "border-slate-800 bg-slate-900/40"
              }`}
            >
              <button type="button" className="block w-full text-left" onClick={() => onSelectFinding(f.id)}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium text-slate-100">{f.title}</span>
                  <span className="chip shrink-0">{formatPct(f.confidence)} conf</span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{f.detail}</p>
                <div className="mt-2 h-1 w-full overflow-hidden rounded bg-slate-800">
                  <div
                    className={`h-full rounded ${selected ? "bg-amber-400" : "bg-amber-400/70"}`}
                    style={{ width: `${Math.round(f.confidence * 100)}%` }}
                  />
                </div>
              </button>
              {f.evidence_refs.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {f.evidence_refs.map((ref) => {
                    const ev = evidence.find((e) => e.id === ref);
                    return (
                      <button
                        key={ref}
                        type="button"
                        className={`chip transition hover:border-amber-500/60 hover:text-amber-300 ${
                          ref === selectedEvidenceId ? "border-amber-500/60 text-amber-300" : ""
                        }`}
                        onClick={() => {
                          onSelectFinding(f.id);
                          onSelectEvidence(ref);
                        }}
                      >
                        evidence · {ev ? ev.type : ref}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
