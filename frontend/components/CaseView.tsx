"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchCase, graphSnapshot, investigate, IS_MOCK } from "@/lib/api";
import { caseMeta } from "@/lib/mocks";
import type {
  CaseSummary,
  Conclusion,
  Evidence,
  ExecuteActionResponse,
  InvestigationResponse,
} from "@/lib/types";
import GraphCanvas from "@/components/GraphCanvas";
import AgentTrace from "@/components/AgentTrace";
import FindingsPanel from "@/components/FindingsPanel";
import EvidenceDetail from "@/components/EvidenceDetail";
import ActionCard from "@/components/ActionCard";

interface InvestigationItem {
  id: string;
  question: string;
  askedAt: number;
  response: InvestigationResponse;
}

// The verdict is computed by the backend rule over graph measurements, not by
// the model — see backend/docs/api-contract.md.
const CONCLUSION_BADGE: Record<Conclusion, string> = {
  suspicious: "badge-warn",
  no_evidence: "badge-info",
  inconclusive: "badge-neutral",
};

const CONCLUSION_LABEL: Record<Conclusion, string> = {
  suspicious: "suspicious activity",
  no_evidence: "no evidence",
  inconclusive: "inconclusive",
};

function LegendDot({ className }: { className: string }) {
  return <span className={`h-1.5 w-1.5 rounded-full ${className}`} />;
}

export default function CaseView({ caseId }: { caseId: string }) {
  const mockMeta = useMemo(() => caseMeta(caseId), [caseId]);
  const [caseInfo, setCaseInfo] = useState<CaseSummary | null>(null);
  const [items, setItems] = useState<InvestigationItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);

  // Live mode: the briefing (title, alert, suggested questions) comes from the
  // backend case store; the fixture copy is the immediate fallback.
  const briefing = caseInfo ?? mockMeta;
  useEffect(() => {
    if (IS_MOCK) return;
    let cancelled = false;
    fetchCase(caseId)
      .then((c) => {
        if (!cancelled) setCaseInfo(c);
      })
      .catch(() => {
        /* fall back to the fixture briefing */
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const active = items.find((i) => i.id === activeId) ?? items[0] ?? null;
  const activeEvidence = useMemo(() => active?.response.evidence ?? [], [active]);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || loading) return;
      setInput("");
      setError(null);
      setLoading(true);
      startedAt.current = Date.now();
      setElapsedMs(0);
      try {
        const response = await investigate(q, caseId);
        const item: InvestigationItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question: q,
          askedAt: Date.now(),
          response,
        };
        setItems((prev) => [item, ...prev]);
        setActiveId(item.id);
        setSelectedFindingId(null);
        setSelectedEvidenceId(null);
      } catch (e) {
        setError(
          e instanceof ApiError
            ? e
            : new ApiError("UNKNOWN", "Something went wrong while investigating. Try again."),
        );
      } finally {
        setLoading(false);
        startedAt.current = null;
      }
    },
    [caseId, loading],
  );

  // Elapsed timer while the agent works.
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => {
      if (startedAt.current) setElapsedMs(Date.now() - startedAt.current);
    }, 250);
    return () => clearInterval(t);
  }, [loading]);

  // In mock mode, auto-run the first suggested question — the deployed shell demos itself.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoRan.current && IS_MOCK && items.length === 0) {
      autoRan.current = true;
      void ask(briefing.suggested_questions[0]);
    }
  }, [ask, items.length, briefing.suggested_questions]);

  const selectedEvidence: Evidence | null =
    activeEvidence.find((e) => e.id === selectedEvidenceId) ?? null;

  const emphasis = useMemo(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    if (selectedEvidence) {
      selectedEvidence.node_ids.forEach((id) => nodeIds.add(id));
      selectedEvidence.edge_ids.forEach((id) => edgeIds.add(id));
    } else if (active && selectedFindingId) {
      const finding = active.response.findings.find((f) => f.id === selectedFindingId);
      for (const ref of finding?.evidence_refs ?? []) {
        const ev = activeEvidence.find((e) => e.id === ref);
        ev?.node_ids.forEach((id) => nodeIds.add(id));
        ev?.edge_ids.forEach((id) => edgeIds.add(id));
      }
    }
    return { nodeIds: Array.from(nodeIds), edgeIds: Array.from(edgeIds) };
  }, [active, activeEvidence, selectedEvidence, selectedFindingId]);

  const metaSegments = useMemo(() => {
    const segments: string[] = [];
    const m = active?.response.meta;
    if (!m) return segments;
    segments.push(m.model ?? m.mode.replace("_", "-"));
    segments.push(`${m.tool_iterations} tool calls`);
    segments.push(`${(m.latency_ms / 1000).toFixed(1)}s`);
    if (m.frozen_accounts.length > 0) segments.push(`${m.frozen_accounts.length} frozen`);
    return segments;
  }, [active]);

  // After an action executes, mirror the backend: apply the returned graph_delta
  // immediately, then refresh the canvas from the snapshot endpoint (current
  // account statuses with the latest investigation's highlights).
  const applyGraphDelta = useCallback((itemId: string, delta: ExecuteActionResponse["graph_delta"]) => {
    if (delta.nodes.length === 0) return;
    const patch = new Map(delta.nodes.map((n) => [n.id, n.status]));
    setItems((prev) =>
      prev.map((item) =>
        item.id !== itemId
          ? item
          : {
              ...item,
              response: {
                ...item.response,
                graph: {
                  ...item.response.graph,
                  nodes: item.response.graph.nodes.map((n) =>
                    patch.has(n.id) ? { ...n, status: patch.get(n.id) } : n,
                  ),
                },
              },
            },
      ),
    );
  }, []);

  const onActionExecuted = useCallback(
    async (result: ExecuteActionResponse) => {
      const itemId = active?.id;
      if (!itemId) return;
      applyGraphDelta(itemId, result.graph_delta);
      try {
        const graph = await graphSnapshot(caseId);
        setItems((prev) =>
          prev.map((item) =>
            item.id === itemId ? { ...item, response: { ...item.response, graph } } : item,
          ),
        );
      } catch {
        // keep the optimistic patch if the snapshot refresh fails
      }
    },
    [active, applyGraphDelta, caseId],
  );

  const noEvidence = active
    ? active.response.conclusion === "no_evidence" || active.response.status === "no_evidence"
    : false;

  return (
    <main className="app-container flex-1 space-y-6 py-6 lg:py-8">
      {/* Case briefing — plain header block, no card */}
      <section className="border-b border-line pb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-[12px] text-faint">{caseId}</span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">{briefing.title}</h1>
          {active && (
            <>
              <span className={`badge ${CONCLUSION_BADGE[active.response.conclusion]}`}>
                {CONCLUSION_LABEL[active.response.conclusion]}
              </span>
              {active.response.status === "partial" && <span className="badge badge-warn">partial</span>}
            </>
          )}
        </div>
        <p className="mt-2.5 max-w-3xl border-l-2 border-accent-line pl-3 text-[13px] leading-relaxed text-muted">
          <span className="text-faint">Alert — </span>
          {briefing.alert}
        </p>
      </section>

      {/* Ask the agent — the primary interaction */}
      <section aria-label="Ask the agent">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <div className="flex gap-2">
            <input
              className="input h-11 text-[14px]"
              placeholder="Ask the agent about this case…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />
            <button
              className="btn btn-primary h-11 shrink-0 px-5"
              type="submit"
              disabled={loading || input.trim().length === 0}
            >
              {loading && (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {loading ? "Investigating…" : "Investigate"}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">
              Suggested
            </span>
            {briefing.suggested_questions.map((q) => (
              <button
                key={q}
                type="button"
                className="text-[12.5px] text-muted transition-colors hover:text-accent disabled:opacity-50"
                disabled={loading}
                onClick={() => void ask(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </form>
      </section>

      {loading && (
        <div className="rounded-lg border border-accent-line bg-accent-soft px-4 py-3.5">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-ping rounded-full bg-accent-fill" />
            <div className="text-sm text-ink">
              Agent investigating — running graph tools…{" "}
              <span className="font-mono text-xs tabular-nums text-accent">{Math.floor(elapsedMs / 1000)}s</span>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-3 w-1/2" />
            <div className="skeleton h-3 w-3/5" />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-danger-line bg-danger-soft px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge badge-danger font-mono">{error.code}</span>
            <span className="text-[13px] text-muted">The investigation did not complete.</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-ink">{error.message}</p>
          <button
            type="button"
            className="btn mt-3"
            onClick={() => {
              const last = items[0]?.question ?? briefing.suggested_questions[0];
              void ask(last);
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!active && !loading && !error && (
        <div className="grid place-items-center rounded-xl bg-raised py-20 text-center text-[13px] text-faint">
          No investigation yet — ask a question above or pick a suggestion.
        </div>
      )}

      {active && (
        <>
          {/* Workspace: network (sticky on desktop) + investigation report */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <section className="xl:col-span-7">
              <div className="xl:sticky xl:top-[73px]">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="eyebrow">Transaction network</h2>
                  <div className="flex items-center gap-3 text-[11px] text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <LegendDot className="bg-graph-ring" /> ring
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <LegendDot className="bg-graph-trail" /> trail
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <LegendDot className="bg-graph-cut" /> cut
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <LegendDot className="bg-graph-frozen" /> frozen
                    </span>
                  </div>
                </div>
                <GraphCanvas graph={active.response.graph} emphasis={emphasis} />
              </div>
            </section>

            {/* One continuous report surface, sections separated by hairlines */}
            <section className="xl:col-span-5">
              <div className="card divide-y divide-line p-0">
                {/* Conclusion first — the headline of the investigation */}
                <div className="px-4 py-4">
                  <p className="text-[12px] leading-snug text-muted">“{active.question}”</p>
                  <h2 className="eyebrow mt-3">
                    Agent conclusion
                    {noEvidence && <span className="text-info"> — no laundering evidence found</span>}
                  </h2>
                  <p className="mt-2 text-[15px] leading-relaxed text-ink">{active.response.summary}</p>
                  {noEvidence && (
                    <p className="mt-2 text-[11px] leading-relaxed text-faint">
                      A defensible no-evidence result — the honest-false-alarm path; the trace below lists
                      every check the agent ran.
                    </p>
                  )}
                  {active.response.meta.notes.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {active.response.meta.notes.map((n) => (
                        <li key={n} className="text-[11px] leading-relaxed text-faint">
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}
                  {metaSegments.length > 0 && (
                    <div className="mt-3 font-mono text-[11px] text-faint tabular-nums">
                      {metaSegments.join("  ·  ")}
                    </div>
                  )}
                </div>

                {active.response.findings.length > 0 && (
                  <div className="px-4 py-4">
                    <h2 className="eyebrow">Findings</h2>
                    <FindingsPanel
                      findings={active.response.findings}
                      evidence={activeEvidence}
                      selectedFindingId={selectedFindingId}
                      selectedEvidenceId={selectedEvidenceId}
                      onSelectFinding={(id) => {
                        setSelectedFindingId(id);
                        setSelectedEvidenceId(null);
                      }}
                      onSelectEvidence={(id) => setSelectedEvidenceId(id)}
                    />
                  </div>
                )}

                {selectedEvidence && (
                  <div className="px-4 py-4">
                    <EvidenceDetail evidence={selectedEvidence} />
                  </div>
                )}

                {active.response.proposed_actions.length > 0 && (
                  <div className="px-4 py-4">
                    <h2 className="eyebrow">Proposed actions</h2>
                    <div className="mt-3 space-y-3">
                      {active.response.proposed_actions.map((a) => (
                        <ActionCard
                          key={a.id}
                          action={a}
                          caseId={caseId}
                          onSelectEvidence={(id) => setSelectedEvidenceId(id)}
                          onExecuted={onActionExecuted}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          {/* Technical trace */}
          <section className="border-t border-line pt-5">
            <h2 className="eyebrow">Agent trace</h2>
            <AgentTrace trace={active.response.trace} />
          </section>

          {/* Investigation feed */}
          {items.length > 1 && (
            <section className="border-t border-line pt-5">
              <h2 className="eyebrow">Investigation feed</h2>
              <ul className="mt-2 divide-y divide-line">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(item.id);
                        setSelectedFindingId(null);
                        setSelectedEvidenceId(null);
                      }}
                      className={`w-full py-2.5 text-left text-sm transition hover:text-accent ${
                        item.id === active.id ? "text-accent" : "text-ink"
                      }`}
                    >
                      <span className="font-mono text-xs tabular-nums text-faint">
                        {new Date(item.askedAt).toLocaleTimeString()}
                      </span>{" "}
                      {item.question}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
