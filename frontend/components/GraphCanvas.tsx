"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import { useTheme } from "@/components/ThemeProvider";
import type { GraphPayload } from "@/lib/types";
import { formatMoney } from "@/lib/format";

// CSS variables that cytoscape needs (it cannot consume `var(--x)` directly).
const GRAPH_TOKENS = [
  "--graph-node",
  "--graph-node-line",
  "--graph-node-label",
  "--graph-device",
  "--graph-device-line",
  "--graph-ip",
  "--graph-ip-line",
  "--graph-frozen",
  "--graph-frozen-line",
  "--graph-edge",
  "--graph-edge-label",
  "--graph-dashed",
  "--graph-trail",
  "--graph-ring",
  "--graph-emphasis",
  "--graph-cut",
  "--graph-flow",
] as const;

type GraphTokens = Record<(typeof GRAPH_TOKENS)[number], string>;

function readGraphTokens(): GraphTokens {
  const styles = getComputedStyle(document.documentElement);
  const tokens = {} as GraphTokens;
  for (const name of GRAPH_TOKENS) tokens[name] = styles.getPropertyValue(name).trim();
  return tokens;
}

function buildGraphStyles(t: GraphTokens): StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        "background-color": t["--graph-node"],
        "border-color": t["--graph-node-line"],
        "border-width": 1.5,
        label: "data(label)",
        color: t["--graph-node-label"],
        "font-size": 10,
        "text-valign": "bottom",
        "text-margin-y": 5,
        width: 30,
        height: 30,
      },
    },
    {
      selector: 'node[kind = "Device"]',
      style: {
        shape: "diamond",
        "background-color": t["--graph-device"],
        "border-color": t["--graph-device-line"],
        width: 20,
        height: 20,
      },
    },
    {
      selector: 'node[kind = "IPAddress"]',
      style: {
        shape: "round-rectangle",
        "background-color": t["--graph-ip"],
        "border-color": t["--graph-ip-line"],
        width: 24,
        height: 17,
      },
    },
    {
      selector: "node.community",
      style: { "border-color": t["--graph-ring"], "border-width": 3 },
    },
    {
      selector: "node.cluster",
      style: { "border-color": t["--graph-dashed"], "border-width": 2, "border-style": "dashed" },
    },
    {
      selector: "node.on-path",
      style: { "border-color": t["--graph-trail"], "border-width": 3 },
    },
    {
      // Freeze-plan markers win over the trail border so the recommendation is visible.
      selector: "node.cut",
      style: { "border-color": t["--graph-cut"], "border-width": 3, "border-style": "dashed" },
    },
    {
      // Frozen accounts dominate: dimmed slate, whatever else they carry.
      selector: "node.frozen",
      style: {
        "background-color": t["--graph-frozen"],
        "border-color": t["--graph-frozen-line"],
        opacity: 0.75,
      },
    },
    {
      selector: "node.emphasis",
      style: {
        "border-color": t["--graph-emphasis"],
        "border-width": 4,
        "overlay-color": t["--graph-emphasis"],
        "overlay-opacity": 0.22,
        "overlay-padding": 7,
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": t["--graph-edge"],
        "target-arrow-color": t["--graph-edge"],
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.8,
        "curve-style": "bezier",
      },
    },
    {
      selector: "edge.dashed",
      style: {
        "line-style": "dashed",
        "line-color": t["--graph-dashed"],
        "target-arrow-color": t["--graph-dashed"],
        opacity: 0.8,
      },
    },
    {
      selector: "edge.flow",
      style: {
        "line-color": t["--graph-flow"],
        "target-arrow-color": t["--graph-flow"],
        width: 2.8,
      },
    },
    {
      selector: "edge.on-path",
      style: { "line-color": t["--graph-trail"], "target-arrow-color": t["--graph-trail"], width: 2.6 },
    },
    {
      selector: "edge.emphasis",
      style: {
        "line-color": t["--graph-emphasis"],
        "target-arrow-color": t["--graph-emphasis"],
        width: 3.4,
      },
    },
    {
      selector: "edge.labeled",
      style: {
        label: "data(label)",
        color: t["--graph-edge-label"],
        "font-size": 8,
        "text-rotation": "autorotate",
      },
    },
  ];
}

export interface Emphasis {
  nodeIds?: string[];
  edgeIds?: string[];
}

/** Positions for backend graphs where only the main path carries x_hint/y_hint:
 * hinted nodes get their exact spot (left → right); the rest are placed at the
 * barycenter of their already-positioned neighbours (devices/IPs sit next to
 * their accounts), and any leftovers go on a deterministic ring. Returns null
 * when no node has hints, so the caller can fall back to a force layout. */
function computePositions(
  graph: GraphPayload,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> | null {
  const hinted = graph.nodes.filter(
    (n) => typeof n.x_hint === "number" && typeof n.y_hint === "number",
  );
  if (hinted.length === 0) return null;

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of hinted) {
    pos.set(n.id, { x: (n.x_hint as number) * width, y: (n.y_hint as number) * height });
  }

  const neighbours = new Map<string, string[]>();
  for (const e of graph.edges) {
    for (const [a, b] of [
      [e.source, e.target],
      [e.target, e.source],
    ] as const) {
      const list = neighbours.get(a);
      if (list) list.push(b);
      else neighbours.set(a, [b]);
    }
  }

  // Unhinted nodes (devices, IPs, side accounts) fan out around the first
  // positioned neighbour, so they sit next to the account they belong to
  // instead of collapsing onto the main path line.
  const fanOut = (anchorId: string, index: number, count: number) => {
    const anchor = pos.get(anchorId) as { x: number; y: number };
    let seed = 0;
    for (let i = 0; i < anchorId.length; i++) seed = (seed * 31 + anchorId.charCodeAt(i)) % 360;
    const angle = ((seed + (360 * index) / Math.max(count, 1)) * Math.PI) / 180;
    const radius = 58 + Math.min(count, 10) * 8;
    return { x: anchor.x + radius * Math.cos(angle), y: anchor.y + radius * Math.sin(angle) };
  };

  for (let pass = 0; pass < 8 && pos.size < graph.nodes.length; pass++) {
    const groups = new Map<string, string[]>();
    for (const n of graph.nodes) {
      if (pos.has(n.id)) continue;
      const anchors = (neighbours.get(n.id) ?? []).filter((id) => pos.has(id)).sort();
      if (anchors.length === 0) continue;
      const list = groups.get(anchors[0]);
      if (list) list.push(n.id);
      else groups.set(anchors[0], [n.id]);
    }
    if (groups.size === 0) break;
    for (const [anchorId, children] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      children.sort();
      children.forEach((childId, i) => pos.set(childId, fanOut(anchorId, i, children.length)));
    }
  }

  const leftovers = graph.nodes
    .filter((n) => !pos.has(n.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const radius = Math.min(width, height) * 0.36;
  const cx = width / 2;
  const cy = height / 2;
  leftovers.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(leftovers.length, 1) - Math.PI / 2;
    pos.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  return pos;
}

export default function GraphCanvas({ graph, emphasis }: { graph: GraphPayload | null; emphasis?: Emphasis }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [ready, setReady] = useState(false);
  const { resolvedTheme } = useTheme();
  const emphasisKey = useMemo(
    () => JSON.stringify({ n: emphasis?.nodeIds ?? [], e: emphasis?.edgeIds ?? [] }),
    [emphasis],
  );

  // Mount cytoscape once (client-side only — dynamic import keeps it out of SSR).
  useEffect(() => {
    let destroyed = false;
    let cy: Core | null = null;
    let onResize: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      const mod = await import("cytoscape");
      const cytoscape = mod.default;
      if (destroyed || !containerRef.current) return;
      cy = cytoscape({
        container: containerRef.current,
        style: buildGraphStyles(readGraphTokens()),
        wheelSensitivity: 0.25,
        minZoom: 0.3,
        maxZoom: 2.5,
      });
      cyRef.current = cy;
      onResize = () => {
        cy?.resize();
      };
      window.addEventListener("resize", onResize);
      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => cy?.resize());
        ro.observe(containerRef.current);
      }
      setReady(true);
    })();

    return () => {
      destroyed = true;
      if (onResize) window.removeEventListener("resize", onResize);
      ro?.disconnect();
      if (cy) cy.destroy();
      cyRef.current = null;
      setReady(false);
    };
  }, []);

  // Rebuild elements (and re-read the theme tokens) whenever the graph, the
  // emphasis, or the active theme changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!ready || !cy) return;

    cy.style(buildGraphStyles(readGraphTokens()));
    cy.elements().remove();
    if (!graph || graph.nodes.length === 0) return;

    cy.resize(); // ensure fresh dimensions after layout changes
    const { n: emphNodeArr, e: emphEdgeArr } = JSON.parse(emphasisKey) as { n: string[]; e: string[] };
    const emphNodes = new Set(emphNodeArr);
    const emphEdges = new Set(emphEdgeArr);
    const communityNodes = new Set((graph.highlight?.communities ?? []).flat());
    const clusterNodes = new Set((graph.highlight?.infrastructure_clusters ?? []).flat());
    const cutNodes = new Set(graph.highlight?.freeze_plan ?? []);
    const pathNodes = new Set((graph.highlight?.paths ?? []).flat());
    const pathPairs: [string, string][] = [];
    for (const p of graph.highlight?.paths ?? []) {
      for (let i = 0; i < p.length - 1; i++) pathPairs.push([p[i], p[i + 1]]);
    }
    const flowPairs = new Set((graph.highlight?.flows ?? []).map(([u, v]) => `${u}->${v}`));
    const transferCount = graph.edges.filter((e) => e.type === "TRANSFER").length;
    const showEdgeLabels = transferCount <= 30;
    const positions = computePositions(graph, cy.width(), cy.height());

    const elements: ElementDefinition[] = [
      ...graph.nodes.map((node) => {
        const classes: string[] = [];
        if (communityNodes.has(node.id)) classes.push("community");
        if (clusterNodes.has(node.id)) classes.push("cluster");
        if (cutNodes.has(node.id)) classes.push("cut");
        if (pathNodes.has(node.id)) classes.push("on-path");
        if (node.status === "frozen") classes.push("frozen");
        if (emphNodes.has(node.id)) classes.push("emphasis");
        const el: ElementDefinition = {
          data: { id: node.id, label: node.id, kind: node.label, status: node.status ?? "active" },
          classes: classes.join(" "),
        };
        const p = positions?.get(node.id);
        if (p) el.position = p;
        return el;
      }),
      ...graph.edges.map((edge) => {
        const classes: string[] = [];
        if (edge.type !== "TRANSFER") classes.push("dashed");
        const onPath = pathPairs.some(
          ([a, b]) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a),
        );
        if (onPath) classes.push("on-path");
        if (flowPairs.has(`${edge.source}->${edge.target}`)) classes.push("flow");
        if (emphEdges.has(edge.id)) classes.push("emphasis");
        const showLabel = showEdgeLabels && edge.type === "TRANSFER" && typeof edge.amount === "number";
        if (showLabel) classes.push("labeled");
        return {
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            kind: edge.type,
            label: showLabel ? formatMoney(edge.amount) : "",
          },
          classes: classes.join(" "),
        } as ElementDefinition;
      }),
    ];

    cy.add(elements);
    cy.layout({ name: positions ? "preset" : "cose", fit: true, padding: 24, animate: false }).run();
  }, [graph, emphasisKey, ready, resolvedTheme]);

  return (
    <div className="relative h-[520px] w-full overflow-hidden rounded-lg border border-line bg-graph-bg xl:h-[600px]">
      {/* Explicit h-full/w-full: cytoscape injects `position: relative` on its container at
          runtime, which would defeat `absolute inset-0` and collapse the height to 0. */}
      <div ref={containerRef} className="h-full w-full" />
      {!graph && (
        <div className="absolute inset-0 grid place-items-center text-sm text-faint">
          The transaction network appears here after the first investigation.
        </div>
      )}
    </div>
  );
}
