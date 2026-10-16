"use client";

// Landing-page centrepiece: the case-001 network (recorded backend response), slowly
// rotating, money particles running along the trail. Decorative only — no interaction.

import { useEffect, useRef } from "react";
import type * as ThreeNS from "three";
import { buildScene, type SceneLink, type SceneNode } from "@/lib/graph3d";
import type { GraphPayload } from "@/lib/types";

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888888";
}

export default function HeroGraph({ graph, seeds }: { graph: GraphPayload; seeds: string[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let destroy: (() => void) | null = null;
    (async () => {
      let mods;
      try {
        mods = await Promise.all([import("3d-force-graph"), import("three")]);
      } catch {
        return; // no WebGL / failed chunk: the stage background still shows
      }
      const [fgMod, THREE] = mods;
      const el = ref.current;
      if (disposed || !el) return;
      const probe = document.createElement("canvas");
      if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) return;

      const model = buildScene(graph, { seeds, suspicious: true });
      const color = (n: SceneNode) =>
        ({
          ring: token("--graph-ring"),
          trail: token("--graph-trail"),
          destination: token("--graph-hub"),
          cluster: token("--graph-node"),
          device: token("--graph-device"),
          ip: token("--graph-ip"),
          other: token("--graph-quiet"),
        })[n.role];
      const glow = glowTexture(THREE);
      const fg = new fgMod.default(el, { controlType: "orbit", rendererConfig: { antialias: true, alpha: true } }) as unknown as import("3d-force-graph").ForceGraph3DInstance<SceneNode, SceneLink>;
      fg.width(el.clientWidth)
        .height(el.clientHeight)
        .backgroundColor("rgba(0,0,0,0)")
        .showNavInfo(false)
        .enablePointerInteraction(false)
        .enableNavigationControls(false)
        .cooldownTicks(1)
        .nodeThreeObject((n: SceneNode) => {
          const g = new THREE.Group();
          const r = n.role === "destination" ? 9 : n.kind !== "Account" ? 5 : n.role === "other" ? 4 : 6.5;
          const c = new THREE.Color(color(n));
          const geom = n.kind === "Device" ? new THREE.OctahedronGeometry(r * 1.1) : n.kind === "IPAddress" ? new THREE.BoxGeometry(r * 1.5, r, r * 1.5) : new THREE.SphereGeometry(r, 24, 16);
          g.add(new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: c, emissive: c, emissiveIntensity: 0.3 })));
          if (n.role === "ring" || n.role === "trail" || n.role === "destination") {
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: c, transparent: true, opacity: 0.5, depthWrite: false }));
            s.scale.set(r * 7, r * 7, 1);
            g.add(s);
          }
          if (n.freezePlan) {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.9, 0.7, 10, 48), new THREE.MeshBasicMaterial({ color: token("--graph-cut") }));
            ring.rotation.x = Math.PI / 2.3;
            g.add(ring);
          }
          return g;
        })
        .linkColor((l: SceneLink) => (l.kind === "trail" ? token("--graph-trail") : l.kind === "flow" ? token("--graph-flow") : token("--graph-dashed")))
        .linkOpacity(0.55)
        .linkWidth((l: SceneLink) => (l.kind === "trail" ? 1.8 : l.kind === "flow" ? 1.4 : 0))
        .linkDirectionalParticles((l: SceneLink) => (l.kind === "trail" ? 3 : l.kind === "flow" ? 1 : 0))
        .linkDirectionalParticleWidth(2.4)
        .linkDirectionalParticleSpeed(0.007)
        .linkDirectionalParticleColor(() => token("--graph-emphasis"));
      (fg.d3Force("link") as unknown as { strength?: (v: number) => unknown } | undefined)?.strength?.(0);
      fg.d3Force("charge", null).d3Force("center", null);
      fg.graphData({ nodes: model.nodes.map((n) => ({ ...n, x: n.fx, y: n.fy, z: n.fz })), links: model.links.map((l) => ({ ...l })) });
      const box = model.bounds;
      const cy = (box.topY + box.floorY) / 2;
      fg.cameraPosition({ x: 0, y: cy + 140, z: 430 }, { x: 0, y: cy, z: 0 }, 0);
      const controls = fg.controls() as { autoRotate?: boolean; autoRotateSpeed?: number; target?: ThreeNS.Vector3 };
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      controls.autoRotate = !reduced;
      controls.autoRotateSpeed = 0.9;
      fg.onEngineStop(() => fg.zoomToFit(0, 10));
      const ro = new ResizeObserver(() => fg.width(el.clientWidth).height(el.clientHeight));
      ro.observe(el);
      destroy = () => {
        ro.disconnect();
        fg._destructor();
      };
    })();
    return () => {
      disposed = true;
      destroy?.();
    };
  }, [graph, seeds]);

  return <div ref={ref} aria-hidden="true" className="h-full w-full" />;
}

let tex: ThreeNS.Texture | null = null;
function glowTexture(THREE: typeof ThreeNS): ThreeNS.Texture {
  if (tex) return tex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
