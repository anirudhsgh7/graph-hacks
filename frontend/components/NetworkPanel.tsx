"use client";

// The "Transaction network" section: route summary, 3D/2D switch, canvas and legend.
// The 3D scene is the default; the Cytoscape 2D canvas remains as a switchable fallback
// (and is used automatically when the browser has no WebGL).

import dynamic from "next/dynamic";
import { useMemo, useState, useSyncExternalStore } from "react";
import GraphCanvas, { type Emphasis } from "@/components/GraphCanvas";
import { buildScene, type Role, type SceneModel } from "@/lib/graph3d";
import { formatMoney } from "@/lib/format";
import type { GraphPayload } from "@/lib/types";

const Graph3D = dynamic(() => import("@/components/Graph3D"), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-[13px] text-faint">Loading 3D view…</div>,
});

function detectWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}
const noop = () => () => {};

// ---- route summary -----------------------------------------------------------------------
const ROLE_DOT: Record<Role, string> = {
  ring: "bg-graph-ring",
  trail: "bg-graph-trail",
  destination: "bg-graph-hub",
  cluster: "bg-graph-checked",
  other: "bg-graph-quiet",
  device: "bg-graph-device",
  ip: "bg-graph-ip",
};

function RouteStrip({ model, suspicious }: { model: SceneModel; suspicious: boolean }) {
  const role = new Map(model.nodes.map((n) => [n.id, n]));
  const { route } = model;
  if (!route && model.frozen.length === 0) return null;
  return (
    <div className="mb-3 space-y-2">
      {route && (
        <div>
          <div className="mb-1.5 text-[11px] text-faint">
            {suspicious ? "Money trail" : "Route checked"}
            {model.otherRoutes > 0 && ` · ${model.otherRoutes} more route${model.otherRoutes === 1 ? "" : "s"} in the graph`}
            <span className="hidden sm:inline"> · amount = total moved on each hop</span>
          </div>
          <ol className="flex flex-wrap items-center gap-y-1.5 font-mono text-[12px]">
            {route.nodes.map((id, i) => {
              const n = role.get(id);
              const hop = route.hops[i];
              return (
                <li key={`${id}-${i}`} className="flex items-center">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 ${
                      n?.freezePlan ? "border-graph-cut text-ink" : "border-line text-ink"
                    }`}
                    title={n?.freezePlan ? "freezing this account cuts the route" : undefined}
                  >
                    <span className={`h-2 w-2 rounded-full ${n?.frozen ? "bg-graph-frozen" : ROLE_DOT[n?.role ?? "other"]}`} />
                    {id}
                  </span>
                  {hop && (
                    <span className="mx-1 inline-flex items-center gap-1 text-[10.5px] text-faint tabular-nums">
                      <span aria-hidden>→</span>
                      {formatMoney(hop.amount)}
                      <span aria-hidden>→</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {(model.freezePlan.length > 0 || model.frozen.length > 0) && (
        <div className="flex flex-wrap gap-2 text-[12px]">
          {model.freezePlan.length > 0 && !model.freezePlan.every((id) => model.frozen.includes(id)) && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-graph-cut bg-surface px-2 py-1 text-ink">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-graph-cut" />
              Freeze <b className="font-mono">{model.freezePlan.join(" + ")}</b> to cut every route
            </span>
          )}
          {model.frozen.length > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 text-ink">
              <span className="h-2.5 w-2.5 rounded-[3px] border-2 border-graph-frozen" />
              Frozen: <b className="font-mono">{model.frozen.join(", ")}</b>
              {(!route || (model.freezePlan.length > 0 && model.freezePlan.every((id) => model.frozen.includes(id)))) && (
                <span className="text-muted"> · every route to the cash-out is cut</span>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---- legend: only what is actually on screen ---------------------------------------------
function Legend({ model, suspicious }: { model: SceneModel; suspicious: boolean }) {
  const has = (r: Role) => model.nodes.some((n) => n.role === r && !n.frozen);
  const kinds = new Set(model.links.map((l) => l.kind));
  const items: { key: string; swatch: React.ReactNode; label: string }[] = [];
  const dot = (cls: string) => <span className={`h-2.5 w-2.5 rounded-full ${cls}`} />;
  if (has("ring")) items.push({ key: "ring", swatch: dot("bg-graph-ring"), label: "mule-ring account" });
  if (has("trail")) items.push({ key: "trail", swatch: dot("bg-graph-trail"), label: "on the money trail" });
  if (has("destination"))
    items.push({ key: "dest", swatch: dot("bg-graph-hub"), label: suspicious ? "cash-out destination" : "destination" });
  if (has("cluster")) items.push({ key: "cluster", swatch: dot("bg-graph-checked"), label: "shares a device, not a ring" });
  if (has("other")) items.push({ key: "other", swatch: dot("bg-graph-quiet"), label: "other account" });
  if (model.freezePlan.length)
    items.push({
      key: "cut",
      swatch: <span className="h-2.5 w-2.5 rounded-full border-2 border-graph-cut" />,
      label: "freeze here (smallest cut)",
    });
  if (model.frozen.length)
    items.push({
      key: "frozen",
      swatch: <span className="h-2.5 w-2.5 rounded-[3px] border-2 border-graph-frozen" />,
      label: "frozen",
    });
  if (has("device")) items.push({ key: "device", swatch: <span className="h-2.5 w-2.5 rotate-45 bg-graph-device" />, label: "phone / device" });
  if (has("ip")) items.push({ key: "ip", swatch: <span className="h-2.5 w-2.5 rounded-[2px] bg-graph-ip" />, label: "IP address" });
  const line = (cls: string) => <span className={`h-[3px] w-4 rounded-full ${cls}`} />;
  if (kinds.has("trail")) items.push({ key: "l-trail", swatch: line("bg-graph-trail"), label: "money moving · thicker = more $" });
  if (kinds.has("checked")) items.push({ key: "l-checked", swatch: line("bg-graph-checked"), label: "route the agent checked" });
  if (kinds.has("flow")) items.push({ key: "l-flow", swatch: line("bg-graph-flow"), label: "extra laundering capacity" });
  if (kinds.has("stopped")) items.push({ key: "l-stop", swatch: line("bg-graph-frozen"), label: "blocked by a freeze" });
  return (
    <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-muted">
      {items.map((i) => (
        <li key={i.key} className="inline-flex items-center gap-1.5">
          {i.swatch}
          {i.label}
        </li>
      ))}
    </ul>
  );
}

export default function NetworkPanel({
  graph,
  emphasis,
  seeds,
  hubs,
  reveal,
  suspicious,
}: {
  graph: GraphPayload;
  emphasis?: Emphasis;
  seeds?: string[];
  hubs?: string[];
  /** Assembly replay (3D only): node ids shown so far; null = all. */
  reveal?: string[] | null;
  suspicious: boolean;
}) {
  const webgl = useSyncExternalStore(noop, detectWebGL, () => true);
  const [choice, setChoice] = useState<"3d" | "2d">("3d");
  const mode = webgl ? choice : "2d";
  const model = useMemo(() => buildScene(graph, { seeds, hubs, suspicious }), [graph, seeds, hubs, suspicious]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">Transaction network</h2>
        <div role="group" aria-label="View" className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-[11.5px]">
          {(["3d", "2d"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={m === "3d" && !webgl}
              aria-pressed={mode === m}
              onClick={() => setChoice(m)}
              className={`rounded-md px-2.5 py-1 font-medium uppercase transition ${
                mode === m ? "bg-raised text-ink shadow-sm" : "text-faint hover:text-ink disabled:opacity-40"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      <RouteStrip model={model} suspicious={suspicious} />

      {mode === "3d" ? (
        <div className="graph-stage h-[440px] w-full overflow-hidden rounded-xl border border-line sm:h-[520px] xl:h-[600px]">
          <Graph3D model={model} emphasis={emphasis} suspicious={suspicious} reveal={reveal} />
        </div>
      ) : (
        <GraphCanvas graph={graph} emphasis={emphasis} />
      )}

      <Legend model={model} suspicious={suspicious} />
    </div>
  );
}
