"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Core, ElementDefinition, StylesheetJson } from "cytoscape";
import type { GraphPayload } from "@/lib/types";
import { formatMoney } from "@/lib/format";

const GRAPH_STYLES: StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "#3b82f6",
      "border-color": "#1d4ed8",
      "border-width": 1.5,
      label: "data(label)",
      color: "#cbd5e1",
      "font-size": 9,
      "text-valign": "bottom",
      "text-margin-y": 4,
      width: 26,
      height: 26,
    },
  },
  {
    selector: 'node[kind = "Device"]',
    style: { shape: "diamond", "background-color": "#a855f7", "border-color": "#7e22ce", width: 18, height: 18 },
  },
  {
    selector: 'node[kind = "IPAddress"]',
    style: { shape: "round-rectangle", "background-color": "#06b6d4", "border-color": "#0e7490", width: 22, height: 16 },
  },
  { selector: "node.frozen", style: { "background-color": "#475569", "border-color": "#334155", opacity: 0.75 } },
  { selector: "node.community", style: { "border-color": "#f43f5e", "border-width": 3 } },
  { selector: "node.on-path", style: { "border-color": "#f59e0b", "border-width": 3 } },
  {
    selector: "node.emphasis",
    style: {
      "border-color": "#fde68a",
      "border-width": 4,
      "overlay-color": "#f59e0b",
      "overlay-opacity": 0.22,
      "overlay-padding": 7,
    },
  },
  {
    selector: "edge",
    style: {
      width: 1.4,
      "line-color": "#334155",
      "target-arrow-color": "#334155",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "curve-style": "bezier",
    },
  },
  { selector: "edge.dashed", style: { "line-style": "dashed", "line-color": "#64748b", "target-arrow-color": "#64748b", opacity: 0.8 } },
  { selector: "edge.on-path", style: { "line-color": "#f59e0b", "target-arrow-color": "#f59e0b", width: 2.4 } },
  { selector: "edge.emphasis", style: { "line-color": "#fde68a", "target-arrow-color": "#fde68a", width: 3.4 } },
  {
    selector: "edge.labeled",
    style: {
      label: "data(label)",
      color: "#94a3b8",
      "font-size": 7.5,
      "text-rotation": "autorotate",
      "text-background-color": "#020617",
      "text-background-opacity": 0.85,
    },
  },
];

export interface Emphasis {
  nodeIds?: string[];
  edgeIds?: string[];
}

export default function GraphCanvas({ graph, emphasis }: { graph: GraphPayload | null; emphasis?: Emphasis }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const [ready, setReady] = useState(false);
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
        style: GRAPH_STYLES,
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

  // Rebuild elements whenever the graph or the emphasis changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!ready || !cy) return;

    cy.elements().remove();
    if (!graph || graph.nodes.length === 0) return;

    cy.resize(); // ensure fresh dimensions after layout changes
    const { n: emphNodeArr, e: emphEdgeArr } = JSON.parse(emphasisKey) as { n: string[]; e: string[] };
    const emphNodes = new Set(emphNodeArr);
    const emphEdges = new Set(emphEdgeArr);
    const communityNodes = new Set((graph.highlight?.communities ?? []).flat());
    const pathNodes = new Set((graph.highlight?.paths ?? []).flat());
    const pathPairs: [string, string][] = [];
    for (const p of graph.highlight?.paths ?? []) {
      for (let i = 0; i < p.length - 1; i++) pathPairs.push([p[i], p[i + 1]]);
    }
    const transferCount = graph.edges.filter((e) => e.type === "TRANSFER").length;
    const showEdgeLabels = transferCount <= 30;
    const width = cy.width();
    const height = cy.height();
    const hasHints = graph.nodes.every((node) => typeof node.x_hint === "number" && typeof node.y_hint === "number");

    const elements: ElementDefinition[] = [
      ...graph.nodes.map((node) => {
        const classes: string[] = [];
        if (communityNodes.has(node.id)) classes.push("community");
        if (pathNodes.has(node.id)) classes.push("on-path");
        if (node.status === "frozen") classes.push("frozen");
        if (emphNodes.has(node.id)) classes.push("emphasis");
        const el: ElementDefinition = {
          data: { id: node.id, label: node.id, kind: node.label, status: node.status ?? "active" },
          classes: classes.join(" "),
        };
        if (hasHints) {
          el.position = { x: (node.x_hint ?? 0.5) * width, y: (node.y_hint ?? 0.5) * height };
        }
        return el;
      }),
      ...graph.edges.map((edge) => {
        const classes: string[] = [];
        if (edge.type !== "TRANSFER") classes.push("dashed");
        const onPath = pathPairs.some(
          ([a, b]) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a),
        );
        if (onPath) classes.push("on-path");
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
    if (hasHints) {
      cy.layout({ name: "preset", fit: true, padding: 34 }).run();
    } else {
      cy.layout({ name: "cose", animate: false, padding: 34 }).run();
    }
  }, [graph, emphasisKey, ready]);

  return (
    <div className="relative h-[520px] w-full overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
      {/* Explicit h-full/w-full: cytoscape injects `position: relative` on its container at
          runtime, which would defeat `absolute inset-0` and collapse the height to 0. */}
      <div ref={containerRef} className="h-full w-full" />
      {!graph && (
        <div className="absolute inset-0 grid place-items-center text-sm text-slate-500">
          The transaction network appears here after the first investigation.
        </div>
      )}
    </div>
  );
}
