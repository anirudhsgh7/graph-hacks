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
    <ul className="mt-2 space-y-1">
      {findings.map((f) => {
        const selected = f.id === selectedFindingId;
        return (
          <li
            key={f.id}
            className={`relative rounded-lg px-3 py-2.5 transition ${
              selected ? "bg-accent-soft" : "hover:bg-raised"
            }`}
          >
            {selected && (
              <span
                aria-hidden="true"
                className="absolute inset-y-2.5 left-0 w-0.5 rounded-full bg-accent-fill"
              />
            )}
            <button type="button" className="block w-full text-left" onClick={() => onSelectFinding(f.id)}>
              <div className="flex items-start justify-between gap-2">
                <span className="text-[13px] font-medium leading-5 text-ink">{f.title}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                  {formatPct(f.confidence)} conf
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{f.detail}</p>
              <div className="mt-2 h-1 w-full overflow-hidden rounded bg-line" aria-hidden="true">
                <div
                  className="h-full rounded bg-accent-fill"
                  style={{ width: `${Math.round(f.confidence * 100)}%` }}
                />
              </div>
            </button>
            {f.evidence_refs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {f.evidence_refs.map((ref) => {
                  const ev = evidence.find((e) => e.id === ref);
                  const evidenceSelected = ref === selectedEvidenceId;
                  return (
                    <button
                      key={ref}
                      type="button"
                      className={`rounded-full border px-2 py-[3px] text-[10.5px] leading-4 transition ${
                        evidenceSelected
                          ? "border-accent-line bg-accent-soft text-accent"
                          : "border-line text-faint hover:border-accent-line hover:text-accent"
                      }`}
                      onClick={() => {
                        onSelectFinding(f.id);
                        onSelectEvidence(ref);
                      }}
                    >
                      evidence · {ev ? ev.type.replace(/_/g, " ") : ref}
                    </button>
                  );
                })}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
