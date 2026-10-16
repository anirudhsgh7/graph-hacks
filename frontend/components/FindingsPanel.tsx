"use client";

import { StepIcon } from "@/components/Icons";
import { findingIcon, findingKeyFigure } from "@/lib/agentRun";
import type { Evidence, Finding } from "@/lib/types";
import { formatPct } from "@/lib/format";

interface Props {
  findings: Finding[];
  evidence: Evidence[];
  selectedFindingId: string | null;
  selectedEvidenceId: string | null;
  onSelectFinding: (id: string) => void;
  onSelectEvidence: (id: string) => void;
  /** Hover preview: the graph highlights the finding's evidence while hovered. */
  onHoverFinding?: (id: string | null) => void;
}

export default function FindingsPanel({
  findings,
  evidence,
  selectedFindingId,
  selectedEvidenceId,
  onSelectFinding,
  onSelectEvidence,
  onHoverFinding,
}: Props) {
  if (findings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {findings.map((f) => {
        const selected = f.id === selectedFindingId;
        const figure = findingKeyFigure(f);
        return (
          <li
            key={f.id}
            onMouseEnter={() => onHoverFinding?.(f.id)}
            onMouseLeave={() => onHoverFinding?.(null)}
            className={`finding-card relative rounded-xl border px-3 py-2.5 transition ${
              selected ? "border-accent-line bg-accent-soft" : "border-transparent hover:border-line hover:bg-raised"
            }`}
          >
            <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => onSelectFinding(f.id)}>
              <span
                className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${
                  selected ? "border-accent-line text-accent" : "border-line text-muted"
                }`}
              >
                <StepIcon name={findingIcon(f, evidence)} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-3">
                  <span className="text-[13px] font-medium leading-5 text-ink">{f.title}</span>
                  {figure && (
                    <span className="shrink-0 font-mono text-[15px] font-semibold leading-5 tabular-nums text-ink">{figure}</span>
                  )}
                </span>
                <span className={`mt-1 block text-xs leading-relaxed text-muted ${selected ? "" : "line-clamp-2"}`}>{f.detail}</span>
                <span className="mt-1.5 flex items-center gap-2" aria-label={`confidence ${formatPct(f.confidence)}`}>
                  <span className="h-1 w-16 overflow-hidden rounded bg-line" aria-hidden="true">
                    <span className="block h-full rounded bg-accent-fill" style={{ width: `${Math.round(f.confidence * 100)}%` }} />
                  </span>
                  <span className="font-mono text-[10.5px] tabular-nums text-faint">{formatPct(f.confidence)} confidence</span>
                </span>
              </span>
            </button>
            {selected && f.evidence_refs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5 pl-11">
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
