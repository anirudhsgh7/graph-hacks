import type { Evidence } from "@/lib/types";

const TYPE_LABEL: Record<Evidence["type"], string> = {
  path: "Path through the graph",
  community: "Community / ring membership",
  shared_entities: "Shared devices or IPs",
  pattern: "Transaction pattern scan",
  algorithm: "Algorithm result",
};

export default function EvidenceDetail({ evidence }: { evidence: Evidence | null }) {
  if (!evidence) return null;
  const nodes = evidence.node_ids;
  const edges = evidence.edge_ids;
  return (
    <div className="card border-amber-500/30">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-300/90">
          Evidence · {evidence.id}
        </h2>
        <span className="chip">{TYPE_LABEL[evidence.type] ?? evidence.type}</span>
      </div>
      <div className="mt-2 text-xs text-slate-400">
        produced by tool <span className="font-mono text-slate-300">{evidence.tool}</span>
      </div>
      {(nodes.length > 0 || edges.length > 0) && (
        <div className="mt-2 space-y-1 text-xs text-slate-400">
          {nodes.length > 0 && (
            <div>
              <span className="text-slate-500">nodes: </span>
              <span className="font-mono text-slate-300">{nodes.slice(0, 12).join(", ")}</span>
              {nodes.length > 12 && <span className="text-slate-500"> +{nodes.length - 12} more</span>}
            </div>
          )}
          {edges.length > 0 && (
            <div>
              <span className="text-slate-500">edges: </span>
              <span className="font-mono text-slate-300">{edges.slice(0, 12).join(", ")}</span>
              {edges.length > 12 && <span className="text-slate-500"> +{edges.length - 12} more</span>}
            </div>
          )}
        </div>
      )}
      <pre className="mt-3 overflow-x-auto rounded bg-slate-950/70 p-2 text-[11px] leading-relaxed text-slate-300">
        {JSON.stringify(evidence.result_excerpt, null, 2)}
      </pre>
      <p className="mt-2 text-[11px] text-slate-500">
        Highlighted on the graph — click another evidence chip to switch.
      </p>
    </div>
  );
}
