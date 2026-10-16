"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchCase, graphSnapshot, investigateStream, IS_MOCK, type StreamStep } from "@/lib/api";
import { revealFrames, stepsFromTrace, type LiveStep } from "@/lib/agentRun";
import { caseMeta } from "@/lib/mocks";
import type { CaseSummary, Conclusion, Evidence, ExecuteActionResponse, InvestigationResponse } from "@/lib/types";
import NetworkPanel from "@/components/NetworkPanel";
import FindingsPanel from "@/components/FindingsPanel";
import EvidenceDetail from "@/components/EvidenceDetail";
import ActionCard from "@/components/ActionCard";
import { LiveTimeline, ProofStrip } from "@/components/AgentRun";
import VerdictHero, { type FreezeOutcome } from "@/components/VerdictHero";

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

const REPLAY_STEP_MS = 520;
const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function CaseView({ caseId }: { caseId: string }) {
  const mockMeta = useMemo(() => caseMeta(caseId), [caseId]);
  const [caseInfo, setCaseInfo] = useState<CaseSummary | null>(null);
  const [items, setItems] = useState<InvestigationItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState("");
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  // what the analyst is looking at (see `emphasis` for the priority order)
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [stickyAccount, setStickyAccount] = useState<string | null>(null);
  const [hoverFindingId, setHoverFindingId] = useState<string | null>(null);
  const [hoverAccount, setHoverAccount] = useState<string | null>(null);
  // graph assembly replay: frame k shows the nodes found by steps 1..k+1
  const [replay, setReplay] = useState<{ itemId: string; frame: number; frames: string[][] } | null>(null);
  const [freezes, setFreezes] = useState<Record<string, FreezeOutcome>>({});
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
  // Cash-out hubs named by the capacity / freeze-plan evidence (still known after a freeze).
  const hubIds = useMemo(() => {
    const hubs = new Set<string>();
    for (const e of activeEvidence) {
      const h = e.result_excerpt["hub_ids"];
      if (Array.isArray(h)) h.forEach((id) => typeof id === "string" && hubs.add(id));
    }
    return [...hubs];
  }, [activeEvidence]);

  const clearSelection = useCallback(() => {
    setSelectedFindingId(null);
    setSelectedEvidenceId(null);
    setSelectedStep(null);
    setStickyAccount(null);
    setHoverFindingId(null);
    setHoverAccount(null);
  }, []);

  const startReplay = useCallback(
    (item: InvestigationItem) => {
      if (reducedMotion() || item.response.trace.length === 0) {
        setReplay(null);
        return;
      }
      setReplay({ itemId: item.id, frame: 0, frames: revealFrames(item.response, briefing.seed_accounts) });
    },
    [briefing.seed_accounts],
  );

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || loading) return;
      setInput("");
      setError(null);
      setLoading(true);
      setPendingQuestion(q);
      setLiveSteps([]);
      startedAt.current = Date.now();
      setElapsedMs(0);
      const onStep = (s: StreamStep) =>
        setLiveSteps((prev) => {
          const i = prev.findIndex((p) => p.step === s.step);
          if (i < 0) return [...prev, s];
          const next = prev.slice();
          next[i] = { ...prev[i], ...s };
          return next;
        });
      try {
        const response = await investigateStream(q, caseId, onStep);
        const item: InvestigationItem = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          question: q,
          askedAt: Date.now(),
          response,
        };
        setItems((prev) => [item, ...prev]);
        setActiveId(item.id);
        clearSelection();
        startReplay(item);
      } catch (e) {
        setError(
          e instanceof ApiError ? e : new ApiError("UNKNOWN", "Something went wrong while investigating. Try again."),
        );
      } finally {
        setLoading(false);
        startedAt.current = null;
      }
    },
    [caseId, loading, clearSelection, startReplay],
  );

  // Elapsed timer while the agent works.
  useEffect(() => {
    if (!loading) return;
    const t = setInterval(() => {
      if (startedAt.current) setElapsedMs(Date.now() - startedAt.current);
    }, 100);
    return () => clearInterval(t);
  }, [loading]);

  // Advance the assembly replay.
  useEffect(() => {
    if (!replay) return;
    const t = setTimeout(
      () => setReplay((r) => (r && r.frame + 1 < r.frames.length ? { ...r, frame: r.frame + 1 } : null)),
      REPLAY_STEP_MS,
    );
    return () => clearTimeout(t);
  }, [replay]);

  // Auto-run the first suggested question in mock mode (the deployed shell demos itself)
  // and whenever the URL asks for it (?run=1, used by the landing page's call to action).
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || items.length > 0) return;
    const wanted = IS_MOCK || new URLSearchParams(window.location.search).has("run");
    if (!wanted) return;
    // deferred (not setState during the effect); the guard is set when it actually runs,
    // so React's dev-mode double effect cannot cancel it
    const t = setTimeout(() => {
      if (autoRan.current) return;
      autoRan.current = true;
      void ask(briefing.suggested_questions[0]);
    }, 0);
    return () => clearTimeout(t);
  }, [ask, items.length, briefing.suggested_questions]);

  const replaying = !!replay && !!active && replay.itemId === active.id;
  const reveal = replaying ? replay.frames[replay.frame] : null;
  const replayStep = replaying ? (active.response.trace[replay.frame]?.step ?? null) : null;

  const selectedEvidence: Evidence | null = activeEvidence.find((e) => e.id === selectedEvidenceId) ?? null;

  // What the graph highlights, in priority order: clicked evidence > clicked step >
  // clicked account > selected finding > hovered finding > hovered account. Clicks fly the
  // camera there; hovers only preview.
  const emphasis = useMemo(() => {
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const addEvidence = (ids: string[]) => {
      for (const ref of ids) {
        const ev = activeEvidence.find((e) => e.id === ref);
        ev?.node_ids.forEach((id) => nodeIds.add(id));
        ev?.edge_ids.forEach((id) => edgeIds.add(id));
      }
    };
    let fly = true;
    if (!active || replaying) return { nodeIds: [], edgeIds: [], fly: false };
    const findingRefs = (id: string | null) => active.response.findings.find((f) => f.id === id)?.evidence_refs ?? [];
    if (selectedEvidence) addEvidence([selectedEvidence.id]);
    else if (selectedStep != null) addEvidence(active.response.trace.find((t) => t.step === selectedStep)?.evidence_ids ?? []);
    else if (stickyAccount) nodeIds.add(stickyAccount);
    else if (selectedFindingId) addEvidence(findingRefs(selectedFindingId));
    else if (hoverFindingId) {
      addEvidence(findingRefs(hoverFindingId));
      fly = false;
    } else if (hoverAccount) {
      nodeIds.add(hoverAccount);
      fly = false;
    }
    return { nodeIds: Array.from(nodeIds), edgeIds: Array.from(edgeIds), fly };
  }, [active, activeEvidence, replaying, selectedEvidence, selectedStep, stickyAccount, selectedFindingId, hoverFindingId, hoverAccount]);

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
                  nodes: item.response.graph.nodes.map((n) => (patch.has(n.id) ? { ...n, status: patch.get(n.id) } : n)),
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
      if (result.type === "freeze_accounts" && result.affected.length) {
        const sim = active.response.proposed_actions.find((a) => a.id === result.action_id)?.simulation;
        setFreezes((prev) => ({
          ...prev,
          [itemId]: {
            accounts: result.affected,
            before: sim?.capacity_before ?? null,
            after: sim?.capacity_after ?? null,
            verified: sim?.verified_on === "fork",
          },
        }));
        clearSelection();
      }
      applyGraphDelta(itemId, result.graph_delta);
      try {
        const graph = await graphSnapshot(caseId);
        setItems((prev) => prev.map((item) => (item.id === itemId ? { ...item, response: { ...item.response, graph } } : item)));
      } catch {
        // keep the optimistic patch if the snapshot refresh fails
      }
    },
    [active, applyGraphDelta, caseId, clearSelection],
  );

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
            <button className="btn btn-primary h-11 shrink-0 px-5" type="submit" disabled={loading || input.trim().length === 0}>
              {loading && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {loading ? "Investigating…" : "Investigate"}
            </button>
          </div>
          <div className="mt-3">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Try asking</span>
            <div className="-mx-1 mt-1.5 flex flex-wrap gap-2 px-1">
              {briefing.suggested_questions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="chip h-auto min-h-8 px-3 py-1.5 text-left text-[12.5px] leading-snug text-muted transition-colors hover:border-accent-line hover:text-ink disabled:opacity-50"
                  disabled={loading}
                  onClick={() => void ask(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </form>
      </section>

      {loading && <LiveTimeline steps={liveSteps} elapsedMs={elapsedMs} question={pendingQuestion} />}

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

      {active && !loading && (
        <>
          {/* The answer first: verdict, the numbers that matter, the conclusion */}
          <VerdictHero
            response={active.response}
            freeze={freezes[active.id] ?? null}
            onFocusAccount={(id, sticky) => {
              if (sticky) {
                setStickyAccount((cur) => (cur === id ? null : id));
                setSelectedEvidenceId(null);
                setSelectedStep(null);
              } else setHoverAccount(id);
            }}
            onSelectEvidence={(id) => {
              setSelectedStep(null);
              setSelectedEvidenceId((cur) => (cur === id ? null : id));
            }}
          />

          {/* Workspace: network (sticky on desktop) + investigation report */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
            <section className="xl:col-span-7">
              <div className="xl:sticky xl:top-[73px]">
                <NetworkPanel
                  graph={active.response.graph}
                  emphasis={emphasis}
                  seeds={briefing.seed_accounts}
                  hubs={hubIds}
                  reveal={reveal}
                  suspicious={active.response.conclusion === "suspicious"}
                />
              </div>
            </section>

            {/* One continuous report surface, sections separated by hairlines */}
            <section className="xl:col-span-5">
              <div className="card divide-y divide-line p-0">
                {active.response.findings.length > 0 && (
                  <div className="px-4 py-4">
                    <h2 className="eyebrow">Findings · hover to preview on the graph</h2>
                    <FindingsPanel
                      findings={active.response.findings}
                      evidence={activeEvidence}
                      selectedFindingId={selectedFindingId}
                      selectedEvidenceId={selectedEvidenceId}
                      onSelectFinding={(id) => {
                        setSelectedFindingId((cur) => (cur === id ? null : id));
                        setSelectedEvidenceId(null);
                        setSelectedStep(null);
                        setStickyAccount(null);
                      }}
                      onSelectEvidence={(id) => setSelectedEvidenceId(id)}
                      onHoverFinding={setHoverFindingId}
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

          {/* Proof strip: every graph step, its algorithm, click to light it up */}
          <section className="border-t border-line pt-5">
            <ProofStrip
              trace={active.response.trace}
              activeStep={replayStep ?? selectedStep}
              playing={replaying}
              onSelectStep={(step) => {
                setSelectedStep(step);
                setSelectedEvidenceId(null);
                setStickyAccount(null);
              }}
              onReplay={() => {
                clearSelection();
                startReplay(active);
              }}
            />
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
                        clearSelection();
                        setReplay(null);
                      }}
                      className={`w-full py-2.5 text-left text-sm transition hover:text-accent ${
                        item.id === active.id ? "text-accent" : "text-ink"
                      }`}
                    >
                      <span className="font-mono text-xs tabular-nums text-faint">
                        {new Date(item.askedAt).toLocaleTimeString()}
                      </span>{" "}
                      {item.question} <span className="text-faint">· {stepsFromTrace(item.response.trace).length} steps</span>
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
