// Scene model for the 3D transaction network (components/Graph3D.tsx).
//
// Pure functions only (no three.js, no DOM) so the layout is deterministic and testable.
//
// Reading the scene:
//   * Top floor  = accounts. Money moves left → right: each account sits in the column of its
//                  longest chain of incoming transfers (victims → alerted account → mules → hub).
//   * Lower floor = shared phones and IP addresses, each under the accounts that use it.
//   * One edge per (sender, receiver) pair: thickness = total money, particles = direction.

import type { GraphHighlight, GraphNode, GraphPayload } from "@/lib/types";

export type Role = "ring" | "trail" | "destination" | "cluster" | "other" | "device" | "ip";
/** trail = laundering route; checked = a route the agent followed that turned out benign. */
export type LinkKind = "trail" | "checked" | "flow" | "transfer" | "stopped" | "infra";

export interface SceneNode {
  id: string;
  kind: "Account" | "Device" | "IPAddress";
  role: Role;
  frozen: boolean;
  freezePlan: boolean;
  seed: boolean;
  label: string;
  detail: GraphNode;
  column: number; // accounts: hop column; infra: -1
  fx: number;
  fy: number;
  fz: number;
  moneyIn: number;
  moneyOut: number;
}

export interface SceneLink {
  id: string;
  source: string;
  target: string;
  kind: LinkKind;
  amount: number;
  count: number;
  edgeIds: string[];
}

export interface SceneModel {
  nodes: SceneNode[];
  links: SceneLink[];
  /** The headline route (first highlighted path) with the money on each hop. */
  route: { nodes: string[]; hops: { from: string; to: string; amount: number }[] } | null;
  otherRoutes: number;
  freezePlan: string[];
  frozen: string[];
  columns: number;
  bounds: { minX: number; maxX: number; topY: number; floorY: number };
  hasInfra: boolean;
}

export const COLUMN_GAP = 66;
const FLOOR_GAP = 120;

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Longest-path layering (Sugiyama step 1) over the transfer pairs, with cycles broken by DFS. */
function layerAccounts(accounts: string[], pairs: [string, string][], preferredStarts: string[]): Map<string, number> {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>(accounts.map((a) => [a, 0]));
  for (const [u, v] of pairs) {
    if (!indeg.has(u) || !indeg.has(v) || u === v) continue;
    (out.get(u) ?? out.set(u, []).get(u)!).push(v);
    indeg.set(v, (indeg.get(v) ?? 0) + 1);
  }
  for (const list of out.values()) list.sort(naturalCompare);

  // DFS order: path starts first, then accounts nobody pays, then the rest — so back edges
  // (cycles) are the ones pointing against the story's direction.
  const order = [
    ...preferredStarts.filter((a) => indeg.has(a)),
    ...accounts.filter((a) => indeg.get(a) === 0).sort(naturalCompare),
    ...[...accounts].sort(naturalCompare),
  ];
  const state = new Map<string, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const forward = new Map<string, string[]>();
  const topo: string[] = [];
  const visit = (start: string) => {
    // iterative DFS (graphs are small, but avoid recursion limits anyway)
    const stack: [string, number][] = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, i] = top;
      const next = out.get(u) ?? [];
      if (i < next.length) {
        top[1] = i + 1;
        const v = next[i];
        const s = state.get(v) ?? 0;
        if (s === 1) continue; // back edge: ignore for layering
        (forward.get(u) ?? forward.set(u, []).get(u)!).push(v);
        if (s === 0) {
          state.set(v, 1);
          stack.push([v, 0]);
        }
      } else {
        state.set(u, 2);
        topo.push(u);
        stack.pop();
      }
    }
  };
  for (const a of order) if ((state.get(a) ?? 0) === 0) visit(a);
  topo.reverse();

  const rank = new Map<string, number>(accounts.map((a) => [a, 0]));
  for (const u of topo) {
    for (const v of forward.get(u) ?? []) rank.set(v, Math.max(rank.get(v) ?? 0, (rank.get(u) ?? 0) + 1));
  }
  return rank;
}

export function buildScene(
  graph: GraphPayload,
  /** hubs: cash-out accounts named by the evidence (capacity / freeze-plan hub_ids), so the
   *  destination stays marked even when a freeze has removed every trail. */
  opts: { seeds?: string[]; suspicious?: boolean; hubs?: string[] } = {},
): SceneModel {
  const hl: GraphHighlight = graph.highlight ?? {};
  // Without a suspicious verdict, a highlighted path is just a route the agent checked:
  // never paint it like a laundering trail.
  const suspicious = opts.suspicious ?? true;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const accounts = graph.nodes.filter((n) => n.label === "Account").map((n) => n.id);
  const infra = graph.nodes.filter((n) => n.label !== "Account");

  const paths = (hl.paths ?? []).filter((p) => p.length > 1 && p.every((id) => byId.has(id)));
  const ringNodes = new Set((hl.communities ?? []).flat());
  const clusterNodes = new Set((hl.infrastructure_clusters ?? []).flat());
  const freezePlan = (hl.freeze_plan ?? []).filter((id) => byId.has(id));
  const frozenSet = new Set([
    ...(hl.frozen ?? []),
    ...graph.nodes.filter((n) => n.status === "frozen").map((n) => n.id),
  ]);
  const trailNodes = new Set(paths.flat());
  const destinations = new Set([...paths.map((p) => p[p.length - 1]), ...(opts.hubs ?? []).filter((id) => byId.has(id))]);
  const starts = new Set(paths.map((p) => p[0]));
  const trailPairs = new Set<string>();
  for (const p of paths) for (let i = 0; i < p.length - 1; i++) trailPairs.add(pairKey(p[i], p[i + 1]));
  const flowPairs = new Set((hl.flows ?? []).filter((f) => f.length === 2).map(([u, v]) => pairKey(u, v)));

  // ---- collapse parallel transfers into one link per ordered pair -----------------------
  const pairs = new Map<string, SceneLink>();
  const infraLinks: SceneLink[] = [];
  const moneyIn = new Map<string, number>();
  const moneyOut = new Map<string, number>();
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    if (e.type !== "TRANSFER") {
      infraLinks.push({ id: e.id, source: e.source, target: e.target, kind: "infra", amount: 0, count: 1, edgeIds: [e.id] });
      continue;
    }
    const key = pairKey(e.source, e.target);
    const amount = typeof e.amount === "number" ? e.amount : 0;
    moneyOut.set(e.source, (moneyOut.get(e.source) ?? 0) + amount);
    moneyIn.set(e.target, (moneyIn.get(e.target) ?? 0) + amount);
    const link = pairs.get(key);
    if (link) {
      link.amount += amount;
      link.count += 1;
      link.edgeIds.push(e.id);
    } else {
      pairs.set(key, { id: `pair:${e.source}->${e.target}`, source: e.source, target: e.target, kind: "transfer", amount, count: 1, edgeIds: [e.id] });
    }
  }
  for (const link of pairs.values()) {
    const key = pairKey(link.source, link.target);
    if (frozenSet.has(link.source) || frozenSet.has(link.target)) link.kind = "stopped";
    else if (trailPairs.has(key)) link.kind = suspicious ? "trail" : "checked";
    else if (flowPairs.has(key)) link.kind = "flow";
  }

  // ---- account columns -----------------------------------------------------------------
  const rank = layerAccounts(accounts, [...pairs.values()].map((l) => [l.source, l.target]), [
    ...(opts.seeds ?? []),
    ...starts,
  ]);
  // Destinations of a trail end the story: put them in the last column they could occupy.
  const maxRank = Math.max(0, ...rank.values());
  for (const d of destinations) if (rank.has(d) && !starts.has(d)) rank.set(d, Math.max(rank.get(d)!, maxRank));
  const columns = Math.max(0, ...rank.values()) + 1;

  const byColumn = new Map<number, string[]>();
  for (const a of accounts) {
    const r = rank.get(a) ?? 0;
    (byColumn.get(r) ?? byColumn.set(r, []).get(r)!).push(a);
  }

  // Order within a column: trail accounts first (they sit on the axis), then by predecessors.
  const position = new Map<string, { x: number; y: number; z: number }>();
  const slot = new Map<string, number>();
  const pred = new Map<string, string[]>();
  for (const l of pairs.values()) (pred.get(l.target) ?? pred.set(l.target, []).get(l.target)!).push(l.source);
  let maxRadius = 0;
  for (let c = 0; c < columns; c++) {
    const members = byColumn.get(c) ?? [];
    const bary = (id: string) => {
      const ps = (pred.get(id) ?? []).map((p) => slot.get(p)).filter((v): v is number => v !== undefined);
      return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : Number.POSITIVE_INFINITY;
    };
    members.sort((a, b) => {
      const ta = trailNodes.has(a) ? 0 : 1;
      const tb = trailNodes.has(b) ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const d = bary(a) - bary(b);
      return Number.isFinite(d) && d !== 0 ? d : naturalCompare(a, b);
    });
    const x = (c - (columns - 1) / 2) * COLUMN_GAP;
    const k = members.length;
    // One account: on the axis. Several: on a circle in the y–z plane, so the column has depth.
    const radius = k <= 1 ? 0 : 26 + 9 * k;
    maxRadius = Math.max(maxRadius, radius);
    members.forEach((id, i) => {
      slot.set(id, i);
      if (k <= 1) {
        position.set(id, { x, y: 0, z: 0 });
        return;
      }
      // First (trail) member near the top. The small phase offset keeps every member's height
      // AND depth distinct, so no two accounts line up from the camera in either orientation.
      const angle = Math.PI / 2 + Math.PI / (4 * k) + (2 * Math.PI * i) / k;
      position.set(id, { x, y: radius * Math.sin(angle), z: radius * Math.cos(angle) });
    });
  }

  // ---- infrastructure floor ------------------------------------------------------------
  const floorY = -(maxRadius + FLOOR_GAP);
  const users = new Map<string, string[]>();
  for (const l of infraLinks) {
    const [acc, dev] = byId.get(l.source)?.label === "Account" ? [l.source, l.target] : [l.target, l.source];
    (users.get(dev) ?? users.set(dev, []).get(dev)!).push(acc);
  }
  const infraSorted = [...infra].sort((a, b) => {
    const xa = meanX(users.get(a.id), position);
    const xb = meanX(users.get(b.id), position);
    return xa - xb || naturalCompare(a.id, b.id);
  });
  const placed: { x: number; z: number }[] = [];
  infraSorted.forEach((n, i) => {
    let x = meanX(users.get(n.id), position);
    let z = (i % 2 === 0 ? 1 : -1) * 34;
    // keep a minimum spacing on the floor
    for (let tries = 0; tries < 12 && placed.some((p) => Math.abs(p.x - x) < 26 && Math.abs(p.z - z) < 26); tries++) {
      if (tries % 2 === 0) z = -z;
      else x += 28;
    }
    placed.push({ x, z });
    position.set(n.id, { x, y: floorY, z });
  });

  // ---- nodes ----------------------------------------------------------------------------
  const seeds = new Set(opts.seeds ?? []);
  const nodes: SceneNode[] = graph.nodes.map((n) => {
    const kind = (n.label === "Device" || n.label === "IPAddress" ? n.label : "Account") as SceneNode["kind"];
    let role: Role;
    if (kind === "Device") role = "device";
    else if (kind === "IPAddress") role = "ip";
    else if (ringNodes.has(n.id)) role = "ring";
    else if (clusterNodes.has(n.id)) role = "cluster";
    else if (suspicious && destinations.has(n.id)) role = "destination";
    else if (suspicious && trailNodes.has(n.id)) role = "trail";
    else role = "other";
    const p = position.get(n.id) ?? { x: 0, y: 0, z: 0 };
    return {
      id: n.id,
      kind,
      role,
      frozen: frozenSet.has(n.id),
      freezePlan: freezePlan.includes(n.id),
      seed: seeds.has(n.id),
      label: n.id,
      detail: n,
      column: kind === "Account" ? rank.get(n.id) ?? 0 : -1,
      fx: p.x,
      fy: p.y,
      fz: p.z,
      moneyIn: moneyIn.get(n.id) ?? 0,
      moneyOut: moneyOut.get(n.id) ?? 0,
    };
  });

  const links = [...pairs.values(), ...infraLinks];
  const xs = nodes.map((n) => n.fx);
  const route = paths[0]
    ? {
        nodes: paths[0],
        hops: paths[0].slice(1).map((to, i) => ({
          from: paths[0][i],
          to,
          amount: pairs.get(pairKey(paths[0][i], to))?.amount ?? 0,
        })),
      }
    : null;

  return {
    nodes,
    links,
    route,
    otherRoutes: Math.max(0, paths.length - 1),
    freezePlan,
    frozen: [...frozenSet].filter((id) => byId.has(id)).sort(naturalCompare),
    columns,
    bounds: {
      minX: xs.length ? Math.min(...xs) : 0,
      maxX: xs.length ? Math.max(...xs) : 0,
      topY: maxRadius,
      floorY,
    },
    hasInfra: infra.length > 0,
  };
}

function meanX(ids: string[] | undefined, pos: Map<string, { x: number }>): number {
  const xs = (ids ?? []).map((id) => pos.get(id)?.x).filter((v): v is number => v !== undefined);
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Human-readable role names (legend, tooltips). */
export function roleName(role: Role, suspicious: boolean): string {
  switch (role) {
    case "ring":
      return "mule-ring account";
    case "trail":
      return "on the money trail";
    case "destination":
      return suspicious ? "cash-out destination" : "where the money ends up";
    case "cluster":
      return "shares a device (not a ring)";
    case "device":
      return "phone / device";
    case "ip":
      return "IP address";
    default:
      return "other account";
  }
}
