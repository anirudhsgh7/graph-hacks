import type { Evidence } from "@/lib/types";

const TYPE_LABEL: Record<string, string> = {
  profile: "Account profile",
  shared_entities: "Shared devices or IPs",
  community: "Community / ring membership",
  path: "Money trail through the graph",
  no_path: "No route between accounts",
  pattern: "Transaction pattern scan",
  ranking: "Algorithm ranking (PageRank)",
  capacity: "Max-flow capacity",
  simulation: "What-if simulation",
  freeze_plan: "Minimum freeze plan (min cut)",
};

export default function EvidenceDetail({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) return null;
  const nodes = evidence.node_ids;
  const edges = evidence.edge_ids;
  const receipts = evidence.receipts ?? [];
  return (
    <div className="rounded-lg bg-accent-soft p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
          Evidence · {evidence.id}
        </h3>
        <span className="text-[10.5px] text-muted">{TYPE_LABEL[evidence.type] ?? evidence.type}</span>
      </div>
      <div className="mt-2 text-[12px] text-muted">
        produced by tool <span className="font-mono text-ink">{evidence.tool}</span>
      </div>
      {(nodes.length > 0 || edges.length > 0) && (
        <div className="mt-2 space-y-1 text-[12px] text-muted">
          {nodes.length > 0 && (
            <div>
              <span className="text-faint">nodes: </span>
              <span className="font-mono text-ink">{nodes.slice(0, 12).join(", ")}</span>
              {nodes.length > 12 && <span className="text-faint"> +{nodes.length - 12} more</span>}
            </div>
          )}
          {edges.length > 0 && (
            <div>
              <span className="text-faint">edges: </span>
              <span className="font-mono text-ink">{edges.slice(0, 12).join(", ")}</span>
              {edges.length > 12 && <span className="text-faint"> +{edges.length - 12} more</span>}
            </div>
          )}
        </div>
      )}
      <pre className="mt-3 overflow-x-auto rounded-md border border-line bg-inset p-2.5 text-[11px] leading-relaxed text-muted">
        {JSON.stringify(evidence.result_excerpt, null, 2)}
      </pre>
      {receipts.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
            Query receipts — replayable
          </div>
          {receipts.map((r, i) => (
            <div key={`${r.query}-${i}`} className="rounded-md border border-line bg-surface p-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <span className="font-mono text-[11px] text-ink">{r.query}</span>
                <span className="font-mono text-[10.5px] text-faint">{JSON.stringify(r.params)}</span>
              </div>
              <details className="mt-1">
                <summary className="cursor-pointer select-none text-[11px] text-muted transition hover:text-accent">
                  cypher
                </summary>
                <pre className="mt-1 overflow-x-auto rounded-md border border-line bg-inset p-2 text-[10.5px] leading-relaxed text-muted">
                  {r.cypher}
                </pre>
              </details>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-faint">
        Highlighted on the graph — click another evidence chip to switch.
      </p>
    </div>
  );
}
