"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, investigate, IS_MOCK } from "@/lib/api";
import { caseMeta } from "@/lib/mocks";
import type { Evidence, InvestigationResponse } from "@/lib/types";
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

export default function CaseView({ caseId }: { caseId: string }) {
  const meta = useMemo(() => caseMeta(caseId), [caseId]);
  const [items, setItems] = useState<InvestigationItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);

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
      void ask(meta.suggested[0]);
    }
  }, [ask, items.length, meta.suggested]);

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

  return (
    <main className="mx-auto w-full max-w-[1400px] flex-1 space-y-4 px-4 py-6 lg:px-6">
      {/* Case briefing */}
      <section className="card">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="chip font-mono">{caseId}</span>
          <h1 className="text-lg font-semibold text-slate-100">{meta.title}</h1>
          {active && <span className="chip">status: {active.response.status}</span>}
        </div>
        <p className="mt-2 text-sm text-slate-400">
          <span className="text-slate-500">Alert: </span>
          {meta.alert}
        </p>
      </section>

      {/* Ask the agent */}
      <section className="card">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex flex-col gap-3"
        >
          <div className="flex gap-2">
            <input
              className="input"
              placeholder="Ask the agent about this case…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={loading}
            />
            <button className="btn btn-primary shrink-0" type="submit" disabled={loading || input.trim().length === 0}>
              {loading ? "Investigating…" : "Investigate"}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {meta.suggested.map((q) => (
              <button
                key={q}
                type="button"
                className="chip transition hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-50"
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
        <section className="card border-amber-500/40">
          <div className="flex items-center gap-3">
            <span className="h-2.5 w-2.5 animate-ping rounded-full bg-amber-400" />
            <div className="text-sm text-amber-200">
              Agent investigating — running graph tools…{" "}
              <span className="font-mono text-xs text-amber-300/80">{Math.floor(elapsedMs / 1000)}s</span>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            <div className="skeleton h-3 w-2/3" />
            <div className="skeleton h-3 w-1/2" />
            <div className="skeleton h-3 w-3/5" />
          </div>
        </section>
      )}

      {error && (
        <section className="card border-rose-500/50 bg-rose-950/30">
          <div className="text-sm font-medium text-rose-300">{error.code}</div>
          <p className="mt-1 text-sm text-rose-200/90">{error.message}</p>
          <button
            type="button"
            className="btn mt-3"
            onClick={() => {
              const last = items[0]?.question ?? meta.suggested[0];
              void ask(last);
            }}
          >
            Retry
          </button>
        </section>
      )}

      {!active && !loading && !error && (
        <section className="card text-sm text-slate-400">
          No investigation yet — ask a question above or pick a suggested one.
        </section>
      )}

      {active && (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            {/* Graph */}
            <section className="card xl:col-span-7">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Transaction network</h2>
                <div className="flex items-center gap-3 text-[11px] text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-rose-500" /> ring
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-amber-400" /> trail
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-slate-500" /> frozen
                  </span>
                </div>
              </div>
              <GraphCanvas graph={active.response.graph} emphasis={emphasis} />
            </section>

            {/* Findings / evidence / actions */}
            <section className="space-y-4 xl:col-span-5">
              <div className="card">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Agent summary</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-200">{active.response.summary}</p>
                <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="chip">asked: “{active.question}”</span>
                  {active.response.meta?.model && <span className="chip">model: {active.response.meta.model}</span>}
                  {typeof active.response.meta?.tool_iterations === "number" && (
                    <span className="chip">{active.response.meta.tool_iterations} tool calls</span>
                  )}
                  {typeof active.response.meta?.latency_ms === "number" && (
                    <span className="chip">{(active.response.meta.latency_ms / 1000).toFixed(1)}s</span>
                  )}
                </div>
              </div>

              {active.response.status === "no_evidence" && (
                <div className="card border-sky-500/40 bg-sky-950/20">
                  <h2 className="text-sm font-semibold text-sky-300">No ring evidence found</h2>
                  <p className="mt-1 text-sm leading-relaxed text-sky-200/80">
                    The agent checked shared entities, pass-through timing and community structure, and concluded the
                    alert is benign. The trace below shows exactly what was run — this is the honest-false-alarm case.
                  </p>
                </div>
              )}

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

              <EvidenceDetail evidence={selectedEvidence} />

              {active.response.proposed_actions.length > 0 && (
                <div className="space-y-3">
                  <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-slate-400">
                    Proposed actions
                  </h2>
                  {active.response.proposed_actions.map((a) => (
                    <ActionCard key={a.id} action={a} onSelectEvidence={(id) => setSelectedEvidenceId(id)} />
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* Trace */}
          <section className="card">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Agent trace</h2>
            <AgentTrace trace={active.response.trace} />
          </section>

          {/* Feed */}
          {items.length > 1 && (
            <section className="card">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Investigation feed</h2>
              <ul className="mt-2 divide-y divide-slate-800">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveId(item.id);
                        setSelectedFindingId(null);
                        setSelectedEvidenceId(null);
                      }}
                      className={`w-full py-2 text-left text-sm transition hover:text-amber-300 ${
                        item.id === active.id ? "text-amber-300" : "text-slate-300"
                      }`}
                    >
                      <span className="font-mono text-xs text-slate-500">
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
