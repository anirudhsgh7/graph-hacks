# plan.md — "Follow the Money"

> **Single source of truth** for the project: what we're building, why, how it works, what the UI does,
> and what happens next. Supersedes the earlier planning brief (`HACKATHON_DISCUSSION.pdf`) and the old
> `docs/` folder — everything important from those now lives here.

**Last updated:** Oct 15, 2026 (Day 1 of the build)

| | |
|---|---|
| Event | **Graph Hacks: Context for AI Agents** — WeMakeDevs × FalkorDB |
| Track | **Track 1 — Agents That Act on Connected Data** |
| Team | 2 people (frontend lead + AI/backend lead); teams of up to 4; one team per person |
| Timeline | Oct 15–18, 2026 · official deadline **Oct 18, 23:59 IST** · internal submit target Oct 18, 20:00 IST |
| Status | **Day 1 complete** — API contract frozen; full frontend console running end-to-end in mock mode (verified: production build, lint, headless-browser QA). Backend (seed + tools + agent) in progress. |
| One-liner | An AI agent that investigates money laundering **on** a transaction graph — finds rings, traces money trails, and simulates the impact of freezing accounts before acting on them. |

---

## 1. What the project is

**Follow the Money** is an anti-money-laundering (AML) investigation console. A fraud analyst opens an
alert, asks the agent a question in plain language, and gets back an *investigation*: findings with
confidence scores, every finding linked to concrete graph evidence (nodes + edges + the tool that
produced them), proposed actions, and a full trace of every tool call the agent made.

**The core loop:**

```
alert → analyst question → agent plans & runs graph tools → evidence-linked findings
      → action proposal with simulated impact → analyst confirms → agent executes on the graph
```

The agent is not a chatbot with a graph bolted on — **the graph is the product**. Rings are communities,
trails are paths, hubs are centrality ranks, and the agent's signature move (freeze an account ring) is
planned by re-running max-flow *with those accounts removed* to predict what happens before anything is
frozen.

**Target user:** a fraud analyst at a payments company / bank who today pivots between spreadsheets,
SQL and intuition. The console gives them an agent that does the graph forensics and shows its work.

---

## 2. Why FalkorDB is load-bearing (the disqualifier rule)

The hackathon disqualifies "a general-purpose chatbot with minimal connection to the graph". Our answer
is this capability table — every product feature is a native graph operation, not decoration:

| Product feature | Graph concept | FalkorDB mechanism |
|---|---|---|
| Mule-ring discovery | community detection over transfers + shared devices + shared IPs | `algo.labelPropagation` over the projected multi-relationship graph |
| Money trail reconstruction | shortest / k-shortest paths | `algo.SPpaths({sourceNode, targetNode, pathCount, maxLen})` |
| Cash-out hub ranking | influence centrality | `algo.pageRank` on the TRANSFER edge projection |
| Freeze-impact simulation | max flow with nodes excluded | `algo.maxFlow` re-run with the frozen accounts removed; surviving capacity = residual laundering route |
| Shared-infrastructure pivot | multi-hop pattern matching | Cypher: `(a)-[:USED_DEVICE|USED_IP]->(x)<-[:USED_DEVICE|USED_IP]-(b)` |
| Layering scan | temporal path patterns | Cypher over `TRANSFER` edges with time-window predicates |

> This table also goes into the submission README and is narrated in the demo video ([Rule 2 protection]).

---

## 3. Architecture

```
┌──────────────────┐   POST /api/investigate   ┌──────────────────┐   Cypher + algo.*   ┌──────────────┐
│  Frontend         │ ────────────────────────▶ │  Backend         │ ──────────────────▶ │  FalkorDB    │
│  Next.js 16       │ ◀──────────────────────── │  FastAPI         │ ◀────────────────── │  (Redis-     │
│  + Cytoscape.js   │   InvestigationResponse   │  agent loop      │   rows + subgraph   │   based)     │
└──────────────────┘   (evidence-linked JSON)   │  + LLM calls     │                     └──────────────┘
```

- **Frontend** — Next.js 16 (App Router, TypeScript, Tailwind v4), Cytoscape.js for the network canvas.
  Built **mock-first**: runs fully against frozen contract fixtures until the backend lands, then flips
  to live with one environment variable.
- **Backend** — FastAPI (Python) with the FalkorDB client. Agent loop: LLM plans → calls graph tools →
  collects evidence → writes findings + proposes actions → returns one typed JSON response. Hosted LLM
  behind an OpenAI-compatible endpoint (default candidate: Gemini free tier; fully env-configurable —
  pending teammate sign-off, see D4).
- **Database** — FalkorDB: Cypher over a property graph, native graph algorithms via `algo.*`, Redis-based.

**Planned agent tools** (names already appear in the real fixtures): `account_summary`,
`shared_entities`, `detect_ring`, `money_trail`, `layering_scan`, `rank_hubs`, `laundering_capacity`,
plus action execution (`execute_freeze`).

---

## 4. Graph data model

**Nodes**

| Label | Properties | Notes |
|---|---|---|
| `Account` | `id`, `holder_name`, `created_at`, `status` (`active` \| `flagged` \| `frozen`), `anomaly_score?` | `status` changes when the agent executes a freeze |
| `Device` | `id`, `type` | enables shared-device pivots |
| `IPAddress` | `id` | enables shared-IP pivots |

**Edges**

| Edge | Properties | Meaning |
|---|---|---|
| `TRANSFER` | `amount`, `ts`, `channel?` | directed money movement |
| `USED_DEVICE` | `first_seen?` | account used a device |
| `USED_IP` | `first_seen?` | account used an IP address |

**Seed data** — a deterministic synthetic generator (fixed RNG seed) producing a few hundred accounts
with realistic noise, plus the three planted structures that match the demo scenarios:

1. a 7-account mule ring feeding a cash-out hub (`case-001`),
2. a 4-hop layering chain from a victim account to a terminal hub (`case-002`),
3. a benign high-volume merchant (the honest false alarm, `case-003`).

The seed script is committed for reproducibility and is re-run before every demo. Keep the dataset
comfortably under the FalkorDB Cloud free-tier 100 MB cap.

---

## 5. The demo scenarios

| Case | Alert | What the agent must show |
|---|---|---|
| `case-001` **Operation Burst** | 14 transfers from A17 within 2 hours to 12 recipients; most accounts opened <30 days ago | The 7-account ring (community detection), the trail A17→A22→A31→A47→H3, and a freeze simulation: $48,200/day → ~$3,900/day with one residual route (A52→A77→H3) |
| `case-002` **Follow the money** | Customer C42 reports an unauthorized $9,800 transfer | The 4-hop chain C42→A91→A33→A75→H1 (~4% shaved per hop, each hop <27 min), hub H1 ranked #3 by PageRank, shared-device pivot between A91 and A33 |
| `case-003` **The quiet merchant** | M8 flagged by the anomaly scorer (top 1% of transaction volume) | **Honest false alarm:** star-shaped community of 121 one-time customers, zero layering hits, no shared entities with known rings → agent recommends closing the alert with its reasoning logged |

Scenario 3 is deliberate: an agent that only ever says "yes, fraud!" is a toy. A defensible
*no-evidence* answer is an integrity feature — and a memorable demo beat.

---

## 6. API contract (v1 — frozen Oct 15)

The boundary between `frontend/` and `backend/`. The frontend consumes only these shapes; the backend
produces them. Additive changes are fine (new optional fields); breaking changes need both teammates to
sign off and a line in the changelog here.

**Endpoints**

| Method & path | Purpose | Priority |
|---|---|---|
| `POST /api/investigate` | Main operation: ask a question, get an investigation | MVP |
| `POST /api/actions/execute` | Confirm & execute a proposed action (e.g. freeze) | MVP |
| `GET /api/graph/snapshot?case_id=` | Current case subgraph for the canvas | MVP |
| `GET /api/cases/{case_id}` | Case state: past questions, findings, audit trail | MVP |
| `GET /api/health` | `{status, db, llm}` — status pill + smoke tests | MVP |
| `POST /api/investigate/stream` | SSE variant of the main operation | Stretch |

**`POST /api/investigate`** — request:

```json
{ "question": "Who is behind the burst of transfers from account A17?", "case_id": "case-001" }
```

Success response (see `frontend/lib/mocks/scenario-1.json` for a full, valid example):

```json
{
  "case_id": "case-001",
  "status": "complete | partial | no_evidence",
  "summary": "one-paragraph narrative the UI renders as-is",
  "findings": [
    { "id": "f-1", "title": "…", "detail": "…", "confidence": 0.86, "evidence_refs": ["ev-1"] }
  ],
  "evidence": [
    {
      "id": "ev-1",
      "type": "path | community | shared_entities | pattern | algorithm",
      "tool": "detect_ring",
      "node_ids": ["A17", "A22"],
      "edge_ids": ["T-1042"],
      "result_excerpt": { "small": "JSON summary of the tool result" }
    }
  ],
  "proposed_actions": [
    {
      "id": "act-1",
      "type": "freeze_accounts",
      "label": "Freeze the 7 ring accounts",
      "requires_confirmation": true,
      "evidence_refs": ["ev-1", "ev-2"],
      "simulation": { "capacity_before": 48200, "capacity_after": 3900, "residual_routes": [["A52", "A77", "H3"]] }
    }
  ],
  "trace": [
    { "step": 1, "tool": "shared_entities", "args": { "account_id": "A17" }, "ok": true, "rows": 8, "duration_ms": 45 }
  ],
  "graph": {
    "nodes": [{ "id": "A17", "label": "Account", "status": "active", "anomaly_score": 0.93, "x_hint": 0.08, "y_hint": 0.3 }],
    "edges": [{ "id": "T-1042", "source": "A17", "target": "A22", "type": "TRANSFER", "amount": 4200, "ts": "2026-10-15T09:14:00Z" }],
    "highlight": { "paths": [["A17", "A22", "A31", "A47", "H3"]], "communities": [["A17", "A22", "A31"]] }
  },
  "meta": { "model": "gemini-flash-class", "tool_iterations": 4, "latency_ms": 8400 }
}
```

**Rules the backend must hold**

1. Every `finding.evidence_refs` entry resolves to an `evidence` item in the same response.
2. Every `evidence.node_ids` / `evidence.edge_ids` entry exists in `graph`.
3. `graph` is bounded (≤ 200 nodes / ≤ 400 edges) — the canvas renders a case subgraph, never the whole DB.
4. `x_hint` / `y_hint` (0..1) are optional but recommended — they make demo layouts deterministic.
5. A finding with no evidence is dropped server-side; `status: "no_evidence"` is a valid, first-class answer.

**`POST /api/actions/execute`**

```json
{ "action_id": "act-1", "confirm": true }
```
```json
{ "action_id": "act-1", "status": "executed", "executed_at": "2026-10-15T10:41:00Z" }
```

**`GET /api/health`**

```json
{ "status": "ok", "db": "ok", "llm": "configured" }
```

**Error envelope (all endpoints)**

```json
{
  "error": {
    "code": "AGENT_TIMEOUT | BAD_REQUEST | DB_UNAVAILABLE | LLM_UNAVAILABLE | LLM_RATE_LIMITED | ACTION_CONFLICT | INTERNAL",
    "message": "human-readable, shown in the UI",
    "detail": {}
  }
}
```

---

## 7. UI details

### 7.1 Screens

**Landing (`/`)** — the case board.

- Sticky header: product name + **status pill** (polls `/api/health` every 15 s; shows `mock data` /
  `backend ok` / `backend unreachable` with a hover tooltip showing db & llm status).
- Hero: title, one-paragraph pitch, four capability chips.
- Three **case cards** (`case-001/002/003`): case id, title, alert summary, "Open investigation →".
- Bottom row: "Why the graph is load-bearing" (the capability table in mini form) and "Data mode"
  (whether the app is on fixtures or a live backend).

**Case console (`/case/[id]`)** — the product itself, top to bottom:

1. **Case briefing** — case id chip, title, live `status` badge (`complete` / `partial` / `no_evidence`),
   and the alert text that triggered the case.
2. **Question bar** — free-text input + **Investigate** button, plus per-case **suggested questions**
   (chips). In mock mode the first suggested question auto-runs on page load so the deployed shell
   demos itself.
3. **Loading banner** (while the agent works) — pulsing dot, live elapsed-seconds counter, skeleton lines.
4. **Error banner** (rose) — error code, human message, **Retry** button.
5. **Main grid**
   - **Left: Transaction network** — the Cytoscape canvas + legend (ring / trail / frozen).
   - **Right:**
     - **Agent summary** — the narrative + chips (asked question, model, tool-call count, latency).
     - **No-evidence banner** (sky blue) when `status: "no_evidence"`.
     - **Findings panel** — each finding: title, detail, confidence % + bar, and evidence chips.
     - **Evidence detail card** — appears on selection: id, type, producing tool, node/edge ids, raw
       `result_excerpt` JSON.
     - **Proposed actions** — action cards with simulated-impact bars (capacity before vs after),
       residual routes, evidence chips, and a **Confirm / Run** button.
6. **Agent trace** (full width) — every tool call in order: tool name, ok/failed badge, rows, ms,
   expandable argument JSON.
7. **Investigation feed** (after more than one question) — click any earlier question to bring its
   findings/evidence/graph back into the panels.

### 7.2 Graph visual language

| Element | Rendering |
|---|---|
| Account | blue circle (`#3b82f6`), labeled with its id |
| Device | purple diamond (`#a855f7`) |
| IPAddress | cyan rounded rectangle (`#06b6d4`) |
| Ring membership (`highlight.communities`) | rose border (`#f43f5e`, thick) |
| Money trail (`highlight.paths`) | amber node border + amber edges (`#f59e0b`) |
| Selected evidence emphasis | bright amber glow (node overlay + thick edges) |
| `USED_DEVICE` / `USED_IP` edges | dashed gray |
| Transfer amounts | edge labels when ≤ 30 transfers in view |
| Frozen accounts | slate/gray, dimmed |
| Layout | deterministic **preset** from `x_hint`/`y_hint` (0..1); falls back to force layout if absent |

### 7.3 Interactions

- Ask via free text (submit) or a suggested-question chip → new investigation.
- Click a finding → graph emphasizes **all of its evidence**; click a specific evidence chip → tight
  emphasis of exactly that evidence's `node_ids`/`edge_ids` + the evidence detail card opens.
- Confirm/Run an action → `POST /api/actions/execute` → card flips to green **executed** (mock mode
  returns success instantly; live mode writes to the graph).
- Graph supports pan/zoom; a `ResizeObserver` keeps the canvas crisp on window resize.
- Header status pill polls `/api/health` every 15 s.

### 7.4 States (all implemented)

| State | Trigger | UI |
|---|---|---|
| idle / empty | case open, nothing asked yet | briefing + question bar + "no investigation yet" card |
| loading | request in flight | amber banner + elapsed-seconds counter + skeletons; input disabled |
| backend unavailable | fetch rejects / health fails | rose banner (typed error code + message) + Retry; header pill red |
| partial | `status: "partial"` | status badge shows `partial`; whatever findings/evidence arrived render normally |
| no evidence | `status: "no_evidence"` | sky banner "No ring evidence found" + full trace to justify the answer |
| action conflict | `ACTION_CONFLICT` from execute | inline message on the action card |
| executed | action confirmed | card flips to green "executed" state |

### 7.5 Mock mode (how the UI runs today)

`NEXT_PUBLIC_API_BASE_URL=mock` (the default) replays the three fixtures in `frontend/lib/mocks/` with
~900 ms simulated latency. The fixtures are **contract-conformant** — they are the frontend's
development source of truth and the backend's implementation target. To go live, point the variable at
the FastAPI service; no component changes are needed.

---

## 8. Repository layout

| Path | What it is | Owner |
|---|---|---|
| `plan.md` | **This document** — single source of truth | both |
| `frontend/` | Next.js investigation console (mock-first) | frontend lead |
| `backend/` | FastAPI agent loop + FalkorDB tool layer + seed generator *(to be created)* | AI/backend lead |
| `queries/` | Annotated Cypher the product depends on *(submission requirement)* | AI/backend lead |
| `.env.example` | Every environment variable across the repo | both |

Frontend internals: `app/` (routes: `/` landing, `/case/[id]` console), `components/` (CaseView,
GraphCanvas, FindingsPanel, EvidenceDetail, ActionCard, AgentTrace, StatusPill, SiteHeader),
`lib/` (types = the contract, api = typed client + mock switch, mocks = fixtures, format helpers).

---

## 9. Running it locally

### Frontend (works today, no backend needed)

```bash
cd frontend
npm install
npm run dev          # → http://localhost:3000
```

Mock mode is the default. Switch to live with `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` in
`frontend/.env.local`.

### Backend (to be built in Phase 1)

```bash
# FalkorDB — local Docker (preferred for dev)
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest   # verify exact image tag at build time

# Backend
cd backend && pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

> ⚠️ The frontend machine does not have a Docker runtime yet — installing Docker Desktop (or falling
> back to a FalkorDB Cloud instance while that's set up) is a Phase-1 setup task.

### Environment variables (canonical list in `.env.example`)

| Variable | Used by | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | frontend | `mock` (fixtures) or the backend URL |
| `FALKORDB_HOST` / `FALKORDB_PORT` | backend | DB endpoint (local Docker: `localhost:6379`) |
| `FALKORDB_USERNAME` / `FALKORDB_PASSWORD` / `FALKORDB_TLS` | backend | Cloud credentials (TLS off on free tier) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | backend | any OpenAI-compatible endpoint |
| `BACKEND_API_TOKEN` | backend | optional abuse guard on mutating endpoints (stretch) |

---

## 10. Deployment & demo-day protocol

| Piece | Where | Notes |
|---|---|---|
| Frontend | **Vercel** (Hobby) | must live under a **personal** GitHub account (Hobby cannot deploy org repos); root directory `frontend/`; set `NEXT_PUBLIC_API_BASE_URL` env var |
| Backend | **Render** (free tier) | cold starts of ~50 s after idle — warm it up before any demo; the status pill exposes health |
| Database | **local Docker** (primary) + **FalkorDB Cloud free tier** (secondary) | Cloud limits (verified): 100 MB, no TLS, **no persistence/backups**, stopped after 1 day idle, deleted after 7 days → never the only copy of anything |

**Demo-day protocol (repeat before every rehearsal and the real run):**

1. Reseed the database (`python seed.py`) — never demo on mutated state.
2. Warm the backend (hit `/api/health`), confirm the status pill is green.
3. Walk scenarios 1 → 2 → 3; fall back to the **recorded demo video** if the live stack misbehaves.

---

## 11. Phases & timeline

Status legend: ✅ done · 🔜 next · ⏳ later. All gates in IST.

### Phase 0 — Foundation (Thu Oct 15) ✅

- ✅ Hackathon research; project decision (D1: the fraud console)
- ✅ API contract v1 frozen (§6)
- ✅ Frontend scaffold + **complete console UI in mock mode**; verified with production build, lint and
  headless-browser QA (zero console errors; all three scenarios render)
- ✅ `.gitignore` rules committed; this `plan.md` written

### Phase 1 — First end-to-end (Fri Oct 16 · gate **M1 at 21:00**) 🔜

Backend lead unless noted:

- [ ] Docker runtime installed (or FalkorDB Cloud instance started) — ⚠️ prerequisite
- [ ] Seed generator + FalkorDB loader; seed committed for reproducibility
- [ ] Tool layer: `shared_entities`, `detect_ring`, `money_trail`, `rank_hubs` (+ `layering_scan`)
- [ ] Agent loop + LLM wiring; `POST /api/investigate` returning the contract shape
- [ ] `GET /api/health` (db + llm checks)
- [ ] Frontend ⇄ backend integration: flip `NEXT_PUBLIC_API_BASE_URL`; `case-001` runs live end-to-end
- [ ] **M1 (Day 2, 21:00): one scenario live end-to-end**

### Phase 2 — Full demo + actions (Sat Oct 17 · gate **M2 at 21:00** · feature freeze 23:00) ⏳

- [ ] Scenarios 2 and 3 live end-to-end
- [ ] Action execution: freeze writes `Account.status = "frozen"`; impact simulation via max-flow re-run
- [ ] Polish every UI state against real error conditions (timeouts, db down, rate limits)
- [ ] **Noon go/no-go on stretch items** (only if MVP is done): SSE streaming, MCP read-only endpoint, anomaly scorer
- [ ] Deploy stack: Render backend + Vercel frontend + database decision
- [ ] **Feature freeze 23:00** — after this, fixes only
- [ ] **M2 (Day 3, 21:00): all three scenarios demo-reliable**

### Phase 3 — Submission (Sun Oct 18 · gates **M3 16:00 / M4 20:00**) ⏳

- [ ] README: graph data model, capability table, setup instructions, screenshots
- [ ] `queries/*.cypher` — annotated queries the tools actually run
- [ ] Demo video (~3 min script: ring discovery → money trail → freeze simulation → confirm → close on
      the honest false alarm)
- [ ] Deployment verified end-to-end + recorded fallback
- [ ] AI-assistant disclosure
- [ ] Two full rehearsals with the reseed protocol
- [ ] **M3 (16:00): submission contents frozen** · **M4: submitted by 20:00** — official deadline **23:59**

### Phase 4 — Stretch / after freeze (priority order)

1. SSE streaming (`/api/investigate/stream`) — live agent trace in the UI
2. MCP server exposing read-only Cypher (Track-1 bonus energy)
3. Anomaly scorer (IsolationForest) as optional garnish — never the demo's core
4. ~$7 Render paid instance to eliminate cold starts (only if rehearsals show it matters)
5. Blog post (side-prize), 45-minute time-box reusing the README

---

## 12. Decision log

Status: ✅ locked · 🟡 drafted (awaiting teammate sign-off) · ⏳ deferred.

| # | Decision | Status | Choice / default |
|---|---|---|---|
| D1 | Project idea | ✅ | Fraud console — "Follow the Money" (AML investigation console) |
| D2 | MVP scope + demo scenarios | 🟡 | Full §5 scenarios 1–3 (scenario 4 as stretch) |
| D3 | Stack | 🟡 | FastAPI + Next.js + Cytoscape.js (frontend already scaffolded) |
| D4 | LLM runtime + provider | 🟡 | Hosted, env-configurable; Gemini free tier first |
| D5 | Database: dev vs demo | 🟡 | Local Docker per laptop + one FalkorDB Cloud instance; reseed before every demo |
| D6 | API contract v1 | ✅ | Frozen (§6 of this document) |
| D7 | Responsibilities | 🟡 | Frontend = UI/viz/deploy/video; backend = seed/tools/agent/README tech sections |
| D8 | Accounts, keys, budget | 🟡 | Each owns accounts; LLM key lives in backend env; $0 spend without agreement |
| D9 | Integration timing | 🟡 | M1 Day 2 21:00; M2 Day 3 21:00; mock-first in between |
| D10 | Deployment path + demo posture | 🟡 | Vercel + Render + Cloud; submit by Sun 20:00; video fallback |
| D11 | Testing/docs/submission plan | 🟡 | Phase 3 checklist (§11) |

🟡 items are **defaults awaiting the teammate meeting** — one by one, they become ✅ or get re-decided.

**Wave 3 (deferred — decide only mid-event, don't discuss now):** SSE streaming (Day 2), anomaly scorer
(Day 3), MCP stretch (Saturday noon go/no-go), Render paid bump (Sunday 12:00), blog post (Day 4).

---

## 13. Roles & responsibilities

| Track | Owns |
|---|---|
| **Frontend lead** | UI, graph visualization, mock contract client, Vercel deployment, demo video, presentation |
| **AI/backend lead** | Seed generator, FalkorDB tool layer, agent loop, FastAPI endpoints, Render deployment, `queries/*.cypher`, README technical sections |
| **Shared** | Scenario scripting, contract changes (both must sign off), rehearsal, submission artifacts |

Rule of thumb: the contract in §6 is the interface. Either side can work alone as long as it doesn't break.

---

## 14. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rule 2: judged as "graph decoration" | Disqualification | Capability table (§2) in README + video; every finding is evidence-linked to graph nodes/edges |
| LLM flakiness / rate limits during demo | Demo failure | Hosted LLM with env-configurable fallback; frozen fixtures + recorded video as last resort |
| Render free-tier cold starts (~50 s) | Awkward demo pause | Warm backend before demo; status pill surfaces health; status pill + timeout banner in UI |
| FalkorDB Cloud: no persistence, idle-stop, deletion after 7 days | Data loss | Local Docker primary; reseed script; seed committed to git — DB is always reproducible |
| No Docker installed yet (frontend machine) | Blocks Phase 1 setup | Phase-1 first task; Cloud instance as bridge |
| 2-person team, 4-day window | Scope risk | Hard milestone gates (M1–M4); feature freeze Sat 23:00; stretch list explicitly deferred |
| Machine failure / accidental deletions | Work loss | Push to GitHub regularly (repo is public-submission anyway) |
| Timezone mixups (deadline 23:59 IST) | Missed deadline | Internal submit target **20:00 IST Sunday** — 4 hours of buffer |

---

## 15. Submission checklist (official requirements)

- [ ] **Public GitHub repository** (`graph-hacks`)
- [ ] **README** including the graph **data model** (§4) and the load-bearing capability table (§2)
- [ ] **`queries/*.cypher`** — annotated Cypher the product depends on
- [ ] **Demo video** (~3 min)
- [ ] **Live deployment** (or clear local-setup instructions in the README)
- [ ] **AI-assistant disclosure**
- [ ] Submitted before **Oct 18, 23:59 IST** (internal target 20:00)

---

## 16. AI-assistant disclosure

This project is built with the help of AI coding assistants during the hackathon window. All code is
reviewed, understood, and explainable by both team members; the final disclosure wording ships in the
submission README.

---

## Glossary

| Term | Meaning |
|---|---|
| **AML** | Anti-money-laundering |
| **Mule ring** | A set of accounts that receive and forward illicit funds to obscure the origin |
| **Layering** | Moving funds through multiple hops (often shaving a fee per hop) to break the trail |
| **Cash-out hub** | An account that aggregates incoming funds for withdrawal |
| **Cypher** | The query language for property graphs, used by FalkorDB |
| **`algo.SPpaths`** | FalkorDB algorithm: shortest/k-shortest paths between two nodes |
| **`algo.labelPropagation`** | FalkorDB algorithm: community detection (finds rings) |
| **`algo.pageRank`** | FalkorDB algorithm: influence ranking (finds hubs) |
| **`algo.maxFlow`** | FalkorDB algorithm: maximum flow between nodes (measures laundering capacity) |
| **SSE** | Server-Sent Events — one-way streaming used by the stretch endpoint |
| **MCP** | Model Context Protocol — exposing the graph as agent tools (stretch) |
