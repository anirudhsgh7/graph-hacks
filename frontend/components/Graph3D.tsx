"use client";

// 3D transaction network. Layout and roles come from lib/graph3d.ts (pure, deterministic);
// this component only turns that model into a three.js scene via 3d-force-graph.
//
//   top floor    accounts, money moving left → right (one link per sender/receiver pair,
//                thickness = money, moving particles = direction)
//   lower floor  shared phones and IP addresses, wired up to the accounts that use them

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ForceGraph3DInstance } from "3d-force-graph";
import type * as ThreeNS from "three";
import { useTheme } from "@/components/ThemeProvider";
import { roleName, type SceneLink, type SceneModel, type SceneNode } from "@/lib/graph3d";
import { formatMoney } from "@/lib/format";
import type { Emphasis } from "@/components/GraphCanvas";

type Libs = {
  ForceGraph3D: typeof import("3d-force-graph").default;
  THREE: typeof ThreeNS;
  SpriteText: typeof import("three-spritetext").default;
};
type FG = ForceGraph3DInstance<SceneNode, SceneLink>;
type LinkEnds = SceneLink & { source: string | SceneNode; target: string | SceneNode };

const TOKENS = [
  "--graph-bg",
  "--graph-node",
  "--graph-device",
  "--graph-ip",
  "--graph-frozen",
  "--graph-frozen-line",
  "--graph-edge",
  "--graph-dashed",
  "--graph-trail",
  "--graph-ring",
  "--graph-emphasis",
  "--graph-cut",
  "--graph-flow",
  "--graph-hub",
  "--graph-quiet",
  "--graph-checked",
  "--graph-floor",
  "--graph-label-bg",
  "--ink",
  "--muted",
] as const;
type Tokens = Record<(typeof TOKENS)[number], string>;

function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const t = {} as Tokens;
  for (const k of TOKENS) t[k] = cs.getPropertyValue(k).trim() || "#888888";
  return t;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const endId = (v: string | SceneNode) => (typeof v === "string" ? v : v.id);

// ---- touch devices: the canvas stays scroll-through until the user opts in ----------------
const coarseQuery = "(pointer: coarse)";
function subscribeCoarse(cb: () => void) {
  const mq = window.matchMedia(coarseQuery);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export default function Graph3D({
  model,
  emphasis,
  suspicious,
  reveal,
}: {
  /** From buildScene() in lib/graph3d.ts (NetworkPanel builds it once for the legend too). */
  model: SceneModel;
  emphasis?: Emphasis;
  suspicious: boolean;
  /** Assembly animation: only these node ids are shown (null = everything). */
  reveal?: string[] | null;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<FG | null>(null);
  const libsRef = useRef<Libs | null>(null);
  const extrasRef = useRef<ThreeNS.Object3D[]>([]);
  const swayRef = useRef<{ on: boolean; raf: number }>({ on: true, raf: 0 });
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [showInfra, setShowInfra] = useState(true);
  // Selection is tied to the model it was made in, so a new graph clears it without an effect.
  const [selection, setSelection] = useState<{ model: SceneModel; id: string } | null>(null);
  const [touchActive, setTouchActive] = useState(false);
  // Portrait containers (phones) turn the scene: money moves top → bottom and the
  // phones/IPs floor becomes a wall behind it, so the story fills a tall screen.
  const [portrait, setPortrait] = useState(false);
  const portraitRef = useRef(false);
  const fitPending = useRef(false);
  const coarse = useSyncExternalStore(subscribeCoarse, () => window.matchMedia(coarseQuery).matches, () => false);
  const locked = coarse && !touchActive;
  const { resolvedTheme } = useTheme();

  const selected = selection && selection.model === model ? selection.id : null;
  const select = useCallback((id: string | null) => setSelection(id ? { model, id } : null), [model]);
  const emphKey = JSON.stringify([emphasis?.nodeIds ?? [], emphasis?.edgeIds ?? [], !!emphasis?.fly]);
  const emph = useMemo(() => {
    const [n, e, fly] = JSON.parse(emphKey) as [string[], string[], boolean];
    return { nodes: new Set(n), edges: new Set(e), active: n.length + e.length > 0, fly };
  }, [emphKey]);
  // Assembly + freeze animations act on the node objects directly (no React re-render).
  const objectsRef = useRef(new Map<string, ThreeNS.Object3D>());
  const revealRef = useRef<Set<string> | null>(null);
  const showInfraRef = useRef(true);
  const prevFrozenRef = useRef<Set<string> | null>(null);

  // ---- mount once -------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      try {
        const [fgMod, THREE, stMod] = await Promise.all([
          import("3d-force-graph"),
          import("three"),
          import("three-spritetext"),
        ]);
        if (disposed || !mountRef.current) return;
        libsRef.current = { ForceGraph3D: fgMod.default, THREE, SpriteText: stMod.default };
        const el = mountRef.current;
        const fg = new fgMod.default(el, { controlType: "orbit", rendererConfig: { antialias: true, alpha: true } }) as unknown as FG;
        fg.width(el.clientWidth)
          .height(el.clientHeight)
          .showNavInfo(false)
          .enableNodeDrag(false)
          .cooldownTicks(1)
          .warmupTicks(0)
          .linkDirectionalArrowRelPos(0.94)
          .linkDirectionalParticleResolution(6);
        // Positions are fixed by the layout model (fx/fy/fz). The link force stays registered
        // because it resolves link endpoints, but with zero strength; the others are removed.
        (fg.d3Force("link") as unknown as { strength?: (v: number) => unknown } | undefined)?.strength?.(0);
        fg.d3Force("charge", null).d3Force("center", null);
        fg.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        const controls = fg.controls() as { enableDamping?: boolean; addEventListener?: (t: string, f: () => void) => void; minDistance?: number; maxDistance?: number };
        controls.enableDamping = true;
        controls.minDistance = 40;
        controls.maxDistance = 1600;
        controls.addEventListener?.("start", () => {
          swayRef.current.on = false; // the user took over the camera
        });
        fgRef.current = fg;
        fg.onEngineStop(() => {
          if (fitPending.current) {
            fitPending.current = false;
            frame(fg, portraitRef.current, 0);
          }
        });
        const measure = () => {
          const w = el.clientWidth;
          const h = el.clientHeight;
          fg.width(w).height(h);
          const p = w / Math.max(h, 1) < 0.8;
          if (p !== portraitRef.current) {
            portraitRef.current = p;
            setPortrait(p);
          } else if (swayRef.current.on) {
            frame(fg, p, 0); // keep everything in view until the user takes the camera
          }
        };
        ro = new ResizeObserver(measure);
        ro.observe(el);
        portraitRef.current = el.clientWidth / Math.max(el.clientHeight, 1) < 0.8;
        setPortrait(portraitRef.current);
        setReady(true);
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    const sway = swayRef.current;
    return () => {
      disposed = true;
      cancelAnimationFrame(sway.raf);
      ro?.disconnect();
      fgRef.current?._destructor();
      fgRef.current = null;
    };
  }, []);

  // ---- draw ---------------------------------------------------------------------------------
  const draw = useCallback(
    (refit: boolean) => {
      const fg = fgRef.current;
      const libs = libsRef.current;
      if (!fg || !libs) return;
      const { THREE, SpriteText } = libs;
      const t = readTokens();
      // layout space → screen space (see `portrait` above)
      const P = (x: number, y: number, z: number) => (portrait ? { x: z, y: -x, z: y } : { x, y, z });
      const scene = fg.scene();
      fg.backgroundColor("rgba(0,0,0,0)");

      const maxAmount = Math.max(1, ...model.links.filter((l) => l.kind !== "infra").map((l) => l.amount));
      const scale = (a: number) => Math.sqrt(a / maxAmount);
      const isEmph = (n: SceneNode) => !emph.active || emph.nodes.has(n.id);
      const dark = document.documentElement.classList.contains("dark");
      // Accounts frozen since the last draw get a one-off pulse.
      const frozenNow = new Set(model.nodes.filter((n) => n.frozen).map((n) => n.id));
      const before = prevFrozenRef.current;
      // captured by the node builder below, which three-forcegraph may run after this call returns
      const pulseIds = new Set(before ? [...frozenNow].filter((id) => !before.has(id)) : []);
      prevFrozenRef.current = frozenNow;
      objectsRef.current.clear();
      const linkEmph = (l: LinkEnds) =>
        !emph.active ||
        l.edgeIds.some((id) => emph.edges.has(id)) ||
        (emph.nodes.has(endId(l.source)) && emph.nodes.has(endId(l.target)));
      const reverse = new Set(model.links.map((l) => `${l.source}>${l.target}`));
      const manyNodes = model.nodes.length > 40;

      const roleColor = (n: SceneNode) => {
        if (n.frozen) return t["--graph-frozen"];
        switch (n.role) {
          case "ring":
            return t["--graph-ring"];
          case "trail":
            return t["--graph-trail"];
          case "destination":
            return t["--graph-hub"];
          case "cluster":
            return t["--graph-node"];
          case "device":
            return t["--graph-device"];
          case "ip":
            return t["--graph-ip"];
          default:
            return t["--graph-quiet"];
        }
      };
      const linkColor = (l: SceneLink) =>
        ({
          trail: t["--graph-trail"],
          checked: t["--graph-checked"],
          flow: t["--graph-flow"],
          transfer: t["--graph-edge"],
          stopped: t["--graph-frozen"],
          infra: t["--graph-dashed"],
        })[l.kind];

      fg.nodeThreeObject((n: SceneNode) => {
        const on = isEmph(n);
        const opacity = on ? 1 : 0.13;
        const color = new THREE.Color(roleColor(n));
        const r = n.role === "destination" ? 9 : n.kind !== "Account" ? 5.2 : n.role === "other" ? 4.4 : 6.6;
        const group = new THREE.Group();
        const geom =
          n.kind === "Device"
            ? new THREE.OctahedronGeometry(r * 1.15)
            : n.kind === "IPAddress"
              ? new THREE.BoxGeometry(r * 1.6, r * 1.1, r * 1.6)
              : new THREE.SphereGeometry(r, 28, 18);
        const body = new THREE.Mesh(
          geom,
          new THREE.MeshLambertMaterial({ color, emissive: color, emissiveIntensity: 0.22, transparent: !on, opacity }),
        );
        group.add(body);
        if (n.frozen) {
          // frozen = an ice cube around the account
          const cube = new THREE.LineSegments(
            new THREE.EdgesGeometry(new THREE.BoxGeometry(r * 2.7, r * 2.7, r * 2.7)),
            new THREE.LineBasicMaterial({ color: t["--graph-frozen-line"], transparent: true, opacity: on ? 0.95 : 0.12 }),
          );
          group.add(cube);
        } else if (n.freezePlan) {
          // freeze here = a violet ring around the account (the cut)
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(r * 1.95, 0.75, 10, 48),
            new THREE.MeshBasicMaterial({ color: t["--graph-cut"], transparent: !on, opacity }),
          );
          ring.rotation.x = Math.PI / 2.3;
          group.add(ring);
        }
        if (emph.active && on) {
          const halo = new THREE.Mesh(
            new THREE.SphereGeometry(r * 2.1, 24, 16),
            new THREE.MeshBasicMaterial({ color: t["--graph-emphasis"], transparent: true, opacity: 0.2, depthWrite: false }),
          );
          group.add(halo);
        }
        // Soft glow behind the accounts that matter (stronger on the dark theme).
        const glowing = !n.frozen && (n.role === "ring" || n.role === "trail" || n.role === "destination" || n.freezePlan);
        if (glowing && on) {
          const glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: glowTexture(THREE),
              color: n.freezePlan ? t["--graph-cut"] : n.role === "destination" ? t["--graph-trail"] : roleColor(n),
              transparent: true,
              opacity: dark ? 0.55 : 0.22,
              depthWrite: false,
            }),
          );
          glow.scale.set(r * 7, r * 7, 1);
          group.add(glow);
        }
        if (pulseIds.has(n.id)) {
          // just frozen: an expanding shock ring (animated in pulse())
          const shock = new THREE.Mesh(
            new THREE.SphereGeometry(r * 1.4, 24, 16),
            new THREE.MeshBasicMaterial({ color: t["--graph-cut"], transparent: true, opacity: 0.6, depthWrite: false, wireframe: true }),
          );
          shock.userData.pulse = true;
          group.add(shock);
        }
        objectsRef.current.set(n.id, group);
        const important = n.role !== "other" || n.seed || n.frozen || n.freezePlan;
        if (important || !manyNodes) {
          const tag = n.frozen
            ? "frozen"
            : n.freezePlan
              ? "freeze here"
              : n.role === "destination"
                ? "cash-out"
                : n.seed
                  ? "alert"
                  : n.kind === "Device"
                    ? (n.detail.kind ?? "device")
                    : "";
          const label = new SpriteText(tag ? `${n.id} · ${tag}` : n.id, important ? 5.6 : 4.2, on ? t["--ink"] : t["--muted"]);
          label.backgroundColor = t["--graph-label-bg"];
          label.padding = [2.2, 1.2];
          label.borderRadius = 2;
          label.fontFace = "ui-sans-serif, system-ui, sans-serif";
          label.fontWeight = important ? "600" : "400";
          label.material.depthWrite = false;
          label.material.opacity = on ? 1 : 0.22;
          srgb(label, THREE);
          label.position.y = r + (n.freezePlan || n.frozen ? 8 : 6);
          group.add(label);
        }
        return group;
      });

      fg.nodeLabel((n: SceneNode) => {
        const d = n.detail;
        const facts =
          n.kind === "Account"
            ? [d.type, d.status, typeof d.anomaly_score === "number" ? `legacy score ${d.anomaly_score.toFixed(2)}` : null]
            : [n.kind === "Device" ? (d.kind ?? "device") : "IP address"];
        const money =
          n.kind === "Account" && (n.moneyIn || n.moneyOut)
            ? `<br/><span class="tip-muted">in view:</span> in ${formatMoney(n.moneyIn)} · out ${formatMoney(n.moneyOut)}`
            : "";
        const flags = [n.seed ? "account in the alert" : "", n.freezePlan ? "freezing it cuts the route" : "", n.frozen ? "frozen by the analyst" : ""]
          .filter(Boolean)
          .join(" · ");
        return `<b>${esc(n.id)}</b> <span class="tip-muted">${esc(roleName(n.role, suspicious))}</span><br/>${esc(
          facts.filter(Boolean).join(" · "),
        )}${money}${flags ? `<br/>${esc(flags)}` : ""}`;
      });

      fg.linkLabel((l: LinkEnds) => {
        const s = esc(endId(l.source));
        const d = esc(endId(l.target));
        if (l.kind === "infra") return `<b>${s}</b> <span class="tip-muted">logs in from</span> <b>${d}</b>`;
        const what = l.kind === "stopped" ? "<br/><span class=\"tip-muted\">stopped: an end is frozen</span>" : "";
        return `<b>${s}</b> → <b>${d}</b><br/>${esc(formatMoney(l.amount))} in ${l.count} transfer${l.count === 1 ? "" : "s"}${what}`;
      });

      // Materials per link (opacity can differ per link, which linkOpacity cannot do).
      const cache = new Map<string, ThreeNS.Material>();
      fg.linkMaterial((l: LinkEnds) => {
        const on = linkEmph(l);
        const cyl = l.kind !== "infra";
        const base = l.kind === "transfer" || l.kind === "stopped" ? 0.55 : l.kind === "infra" ? 0.45 : 0.92;
        const opacity = on ? base : 0.06;
        const key = `${l.kind}|${on}|${cyl}`;
        let m = cache.get(key);
        if (!m) {
          const color = linkColor(l);
          m = cyl
            ? new THREE.MeshLambertMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: 0.25, transparent: true, opacity, depthWrite: opacity > 0.5 })
            : new THREE.LineBasicMaterial({ color, transparent: true, opacity });
          cache.set(key, m);
        }
        return m;
      });
      fg.linkWidth((l: SceneLink) => {
        if (l.kind === "infra") return 0;
        if (l.kind === "trail" || l.kind === "checked") return 0.9 + 2.6 * scale(l.amount);
        if (l.kind === "flow") return 0.8 + 2.0 * scale(l.amount);
        return 0.35 + 1.0 * scale(l.amount);
      })
        .linkCurvature((l: SceneLink) => (reverse.has(`${l.target}>${l.source}`) ? 0.3 : 0))
        .linkDirectionalArrowLength((l: SceneLink) => (l.kind === "infra" ? 0 : l.kind === "transfer" || l.kind === "stopped" ? 2.6 : 3.8))
        .linkDirectionalArrowColor((l: SceneLink) => linkColor(l))
        .linkDirectionalParticles((l: LinkEnds) => {
          if (!linkEmph(l)) return 0;
          if (l.kind === "trail") return 2 + Math.round(2 * scale(l.amount));
          if (l.kind === "checked") return 2;
          if (l.kind === "flow") return 1;
          return 0;
        })
        .linkDirectionalParticleWidth((l: SceneLink) => (l.kind === "flow" ? 1.6 : 2.3))
        .linkDirectionalParticleSpeed((l: SceneLink) => (l.kind === "flow" ? 0.004 : 0.0065))
        .linkDirectionalParticleColor((l: SceneLink) => (l.kind === "trail" ? t["--graph-emphasis"] : linkColor(l)))
      showInfraRef.current = showInfra;
      applyVisibility(fg, showInfraRef.current, revealRef.current);

      // ---- scene furniture: the devices floor and the direction of money ------------------
      for (const o of extrasRef.current) {
        scene.remove(o);
        o.traverse((c) => {
          const mesh = c as ThreeNS.Mesh;
          mesh.geometry?.dispose?.();
          const mat = mesh.material as ThreeNS.Material | ThreeNS.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
          else mat?.dispose?.();
        });
      }
      extrasRef.current = [];
      const { minX, maxX, topY, floorY } = model.bounds;
      const width = Math.max(140, maxX - minX + 120);
      const cx = (minX + maxX) / 2;
      if (model.hasInfra && showInfra) {
        const grid = new THREE.GridHelper(width, Math.round(width / 20), t["--graph-floor"], t["--graph-floor"]);
        if (portrait) {
          grid.scale.x = 140 / width; // local x → screen x (short side)
          grid.rotation.x = Math.PI / 2; // local z → screen -y (long side): a wall behind the money
          grid.position.set(0, -cx, floorY - 7);
        } else {
          grid.scale.z = 140 / width;
          grid.position.set(cx, floorY - 7, 0);
        }
        (grid.material as ThreeNS.Material).transparent = true;
        (grid.material as ThreeNS.Material).opacity = 0.55;
        scene.add(grid);
        const floorLabel = new SpriteText("SHARED PHONES & IP ADDRESSES", 4.6, t["--muted"]);
        floorLabel.fontWeight = "600";
        const fl = portrait ? { x: 0, y: -maxX - 46, z: floorY - 7 } : P(cx, floorY - 7, 74);
        floorLabel.position.set(fl.x, fl.y, fl.z);
        floorLabel.material.depthWrite = false;
        srgb(floorLabel, THREE);
        scene.add(floorLabel);
        extrasRef.current.push(grid, floorLabel);
      }
      if (model.columns > 1) {
        const arrow = new SpriteText(portrait ? "MONEY MOVES  ↓" : "MONEY MOVES  →", 5.2, t["--muted"]);
        arrow.fontWeight = "600";
        const ap = portrait ? { x: 0, y: -minX + topY + 16, z: 0 } : { x: cx, y: topY + 34, z: 0 };
        arrow.position.set(ap.x, ap.y, ap.z);
        arrow.material.depthWrite = false;
        srgb(arrow, THREE);
        scene.add(arrow);
        extrasRef.current.push(arrow);
      }

      fg.graphData({
        nodes: model.nodes.map((n) => {
          const q = P(n.fx, n.fy, n.fz);
          return { ...n, fx: q.x, fy: q.y, fz: q.z, x: q.x, y: q.y, z: q.z };
        }),
        links: model.links.map((l) => ({ ...l })),
      });

      // The camera is fitted when the engine has placed the nodes (onEngineStop).
      if (refit) fitPending.current = true;
      if (pulseIds.size) {
        // give the library a moment to build the new node objects, then animate them
        setTimeout(() => pulse([...pulseIds].map((id) => objectsRef.current.get(id)).filter(Boolean) as ThreeNS.Object3D[]), 120);
      }
    },
    [emph, model, portrait, showInfra, suspicious],
  );

  // Rebuild when data/theme/emphasis/layer toggles change; refit the camera only when the
  // graph itself changes, so selecting evidence doesn't throw the viewer around.
  const lastFit = useRef<{ model: SceneModel; portrait: boolean } | null>(null);
  useEffect(() => {
    if (!ready) return;
    const refit = lastFit.current?.model !== model || lastFit.current?.portrait !== portrait;
    lastFit.current = { model, portrait };
    draw(refit);
    if (refit) startSway(fgRef.current, swayRef.current);
  }, [ready, draw, model, portrait, resolvedTheme]);

  // Focus the camera on emphasized evidence (click a finding / evidence chip); when the
  // emphasis is cleared, frame the whole network again.
  const wasEmph = useRef(false);
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    if (emph.active && emph.fly) {
      swayRef.current.on = false;
      fg.zoomToFit(700, 50, (n: SceneNode) => emph.nodes.has(n.id));
      wasEmph.current = true;
    } else if (!emph.active && wasEmph.current) {
      frame(fg, portraitRef.current, 700);
      wasEmph.current = false;
    }
  }, [emph, ready]);

  // Assembly: show only the revealed nodes; newly revealed ones pop in.
  const revealKey = reveal ? reveal.join(",") : null;
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    const prev = revealRef.current;
    const next = revealKey === null ? null : new Set(revealKey ? revealKey.split(",") : []);
    revealRef.current = next;
    applyVisibility(fg, showInfraRef.current, next);
    if (next) {
      const fresh = [...next].filter((id) => !prev || !prev.has(id));
      popIn(fresh.map((id) => objectsRef.current.get(id)).filter(Boolean) as ThreeNS.Object3D[]);
    }
  }, [revealKey, ready]);

  // Pointer interaction follows the touch lock.
  useEffect(() => {
    const fg = fgRef.current;
    if (!ready || !fg) return;
    fg.enableNavigationControls(!locked).enablePointerInteraction(!locked);
    fg.onNodeClick((n: SceneNode) => {
      swayRef.current.on = false;
      select(n.id);
      // fly towards the account, keeping the current viewing angle
      const at = { x: n.fx, y: n.fy, z: n.fz }; // screen-space position (set in draw)
      const cam = fg.cameraPosition();
      const dx = cam.x - at.x;
      const dy = cam.y - at.y;
      const dz = cam.z - at.z;
      const k = 170 / (Math.hypot(dx, dy, dz) || 1);
      fg.cameraPosition({ x: at.x + dx * k, y: at.y + dy * k, z: at.z + dz * k }, at, 800);
    });
    fg.onBackgroundClick(() => select(null));
  }, [locked, ready, select]);

  const selectedNode = selected ? model.nodes.find((n) => n.id === selected) ?? null : null;
  const selectedLinks = selectedNode
    ? model.links.filter((l) => l.kind !== "infra" && (l.source === selectedNode.id || l.target === selectedNode.id))
    : [];

  if (failed) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-muted">
        3D view could not start on this device (WebGL unavailable). Switch to the 2D view.
      </div>
    );
  }

  return (
    <div data-graph-root className="flex h-full w-full flex-col">
      {/* toolbar above the canvas, so it never covers the scene */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-2 py-1.5">
        <div className="flex flex-wrap gap-1.5">
          {model.hasInfra && (
            <button
              type="button"
              className={`chip h-7 px-2.5 text-[11.5px] ${showInfra ? "text-ink" : "text-faint line-through"}`}
              onClick={() => setShowInfra((v) => !v)}
              aria-pressed={showInfra}
            >
              phones & IPs
            </button>
          )}
          <button
            type="button"
            className="chip h-7 px-2.5 text-[11.5px] text-ink"
            onClick={() => {
              swayRef.current.on = false;
              select(null);
              if (fgRef.current) frame(fgRef.current, portraitRef.current, 700);
            }}
          >
            reset view
          </button>
        </div>
        {coarse && touchActive && (
          <button type="button" className="chip h-7 px-2.5 text-[11.5px] text-ink" onClick={() => setTouchActive(false)}>
            done
          </button>
        )}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={mountRef} className={`h-full w-full ${locked ? "pointer-events-none" : ""}`} />

        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-[13px] text-faint">Building the 3D network…</div>
        )}

        {locked && ready && (
          <button
            type="button"
            onClick={() => setTouchActive(true)}
            className="btn absolute bottom-3 left-1/2 -translate-x-1/2 bg-surface/90 text-[12.5px] shadow-sm backdrop-blur"
          >
            Tap to explore in 3D
          </button>
        )}

        {!locked && ready && !selectedNode && (
          <p className="pointer-events-none absolute bottom-2 left-3 text-[10.5px] text-faint">
            {coarse ? "drag to orbit · pinch to zoom · tap an account" : "drag to orbit · scroll to zoom · right-drag to pan · click an account"}
          </p>
        )}

        {selectedNode && (
          <div className="absolute bottom-2 left-2 right-2 max-w-sm rounded-lg border border-line bg-surface/95 p-3 text-[12px] shadow-sm backdrop-blur sm:right-auto">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-mono text-[13px] font-semibold text-ink">{selectedNode.id}</span>{" "}
                <span className="text-muted">{roleName(selectedNode.role, suspicious)}</span>
                {selectedNode.frozen && <span className="badge badge-neutral ml-1.5">frozen</span>}
                {selectedNode.freezePlan && !selectedNode.frozen && <span className="badge badge-info ml-1.5">freeze here</span>}
              </div>
              <button type="button" className="text-faint hover:text-ink" aria-label="Close" onClick={() => select(null)}>
                ✕
              </button>
            </div>
            {selectedLinks.length > 0 ? (
              <ul className="mt-2 max-h-28 space-y-0.5 overflow-auto font-mono text-[11.5px] tabular-nums">
                {selectedLinks
                  .slice()
                  .sort((a, b) => b.amount - a.amount)
                  .map((l) => (
                    <li key={l.id} className="flex justify-between gap-3">
                      <span className={l.source === selectedNode.id ? "text-ink" : "text-muted"}>
                        {l.source === selectedNode.id ? `sent → ${l.target}` : `received ← ${l.source}`}
                      </span>
                      <span className="text-ink">
                        {formatMoney(l.amount)}
                        <span className="text-faint"> ×{l.count}</span>
                      </span>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-1.5 text-muted">No transfers in this view.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A 3/4 view (front-right, from above) of every node, fitted to the canvas.
 * Framed from the layout positions (fx/fy/fz), not from rendered objects, so animations
 * (assembly pop-in, pulses) and hidden nodes never change the framing. */
function frame(fg: FG, portrait: boolean, ms: number) {
  const nodes = fg.graphData().nodes as SceneNode[];
  if (!nodes.length) return;
  const pts = nodes.map((n) => ({ x: n.fx, y: n.fy, z: n.fz }));
  const lo = { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)), z: Math.min(...pts.map((p) => p.z)) };
  const hi = { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)), z: Math.max(...pts.map((p) => p.z)) };
  const c = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
  // direction from the centre towards the camera; portrait is nearly head-on
  const raw = portrait ? { x: 0.08, y: 0.3, z: 1 } : { x: 0.22, y: 0.38, z: 1 };
  const len = Math.hypot(raw.x, raw.y, raw.z);
  const dir = { x: raw.x / len, y: raw.y / len, z: raw.z / len };
  // camera axes: right = up × dir, upv = dir × right
  let right = { x: dir.z, y: 0, z: -dir.x };
  const rl = Math.hypot(right.x, right.z) || 1;
  right = { x: right.x / rl, y: 0, z: right.z / rl };
  const upv = { x: dir.y * right.z - dir.z * right.y, y: dir.z * right.x - dir.x * right.z, z: dir.x * right.y - dir.y * right.x };
  const cam = fg.camera() as ThreeNS.PerspectiveCamera;
  const tanV = Math.tan(((cam.fov ?? 50) * Math.PI) / 360);
  const tanH = tanV * (cam.aspect || 1);
  const PAD = 22; // node radius + label above it
  let dist = 110 / tanV; // small graphs: never zoom in closer than this
  for (const p of pts) {
    const l = { x: p.x - c.x, y: p.y - c.y, z: p.z - c.z };
    const along = l.x * dir.x + l.y * dir.y + l.z * dir.z;
    const u = Math.abs(l.x * upv.x + l.y * upv.y + l.z * upv.z) + PAD;
    const r = Math.abs(l.x * right.x + l.z * right.z) + PAD;
    dist = Math.max(dist, along + u / tanV, along + r / tanH);
  }
  dist *= 1.06;
  fg.cameraPosition({ x: c.x + dir.x * dist, y: c.y + dir.y * dist, z: c.z + dir.z * dist }, c, ms);
}

/** Gentle left–right sway until the user touches the camera, so the depth is obvious. */
function startSway(fg: FG | null, sway: { on: boolean; raf: number }) {
  if (!fg) return;
  cancelAnimationFrame(sway.raf);
  const controls = fg.controls() as { autoRotate?: boolean; autoRotateSpeed?: number };
  const t0 = performance.now();
  const step = () => {
    if (!sway.on) {
      controls.autoRotate = false;
      return;
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.45 * Math.cos((performance.now() - t0) / 2600);
    sway.raf = requestAnimationFrame(step);
  };
  sway.raf = requestAnimationFrame(step);
}

/** Canvas-text sprites must be tagged sRGB, or three.js renders them washed out. */
function srgb(sprite: { material: ThreeNS.SpriteMaterial }, THREE: typeof ThreeNS) {
  const map = sprite.material.map;
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
  }
}

function applyVisibility(fg: FG, showInfra: boolean, reveal: Set<string> | null) {
  const visible = (n: SceneNode) => (showInfra || n.kind === "Account") && (!reveal || reveal.has(n.id));
  fg.nodeVisibility(visible).linkVisibility((l: LinkEnds) => {
    const s = typeof l.source === "string" ? null : l.source;
    const t = typeof l.target === "string" ? null : l.target;
    if (!showInfra && l.kind === "infra") return false;
    if (!reveal) return true;
    return reveal.has(endId(l.source)) && reveal.has(endId(l.target)) && (!s || visible(s)) && (!t || visible(t));
  });
}

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Scale freshly revealed nodes up from nothing (assembly animation). */
function popIn(objs: ThreeNS.Object3D[]) {
  if (!objs.length || reducedMotion()) return;
  const t0 = performance.now();
  objs.forEach((o) => o.scale.setScalar(0.01));
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 420);
    const s = 1 + 0.25 * Math.sin(Math.PI * k) * (1 - k); // slight overshoot, settles at 1
    objs.forEach((o) => o.scale.setScalar(Math.max(0.01, k * s)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Expanding, fading shock ring on accounts that were just frozen. */
function pulse(groups: ThreeNS.Object3D[]) {
  const shocks = groups.flatMap((g) => g.children.filter((c) => c.userData.pulse)) as ThreeNS.Mesh[];
  if (!shocks.length) return;
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / 1500);
    for (const m of shocks) {
      m.scale.setScalar(1 + 3.2 * k);
      (m.material as ThreeNS.MeshBasicMaterial).opacity = 0.6 * (1 - k);
      m.visible = k < 1;
    }
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

let glowTex: ThreeNS.Texture | null = null;
/** Radial-gradient sprite texture for node glows (built once). */
function glowTexture(THREE: typeof ThreeNS): ThreeNS.Texture {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.25, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
