# plan.md — "Follow the Money"

> **Single source of truth** for the project: what we're building, why, how it works, what the UI does,
> and what happens next. Supersedes the earlier planning brief (`HACKATHON_DISCUSSION.pdf`) and the old
> `docs/` folder — everything important from those now lives here.

**Last updated:** Oct 16, 2026 (Day 2 — backend delivered, frontend integrated against contract v1.1)

| | |
|---|---|
| Event | **Graph Hacks: Context for AI Agents** — WeMakeDevs × FalkorDB |
| Track | **Track 1 — Agents That Act on Connected Data** |
| Team | 2 people (frontend lead + AI/backend lead); teams of up to 4; one team per person |
| Timeline | Oct 15–18, 2026 · official deadline **Oct 18, 23:59 IST** · internal submit target Oct 18, 20:00 IST |
| Status | **Day 2** — backend delivered (seed + tools + agent + tests + fixtures); frontend runs in mock mode against the recordings and flips to live with one env var. |
| One-liner | An AI agent that investigates money laundering **on** a transaction graph — finds rings, traces money trails, and proves the smallest freeze that stops the cash-out before acting on it. |

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
- **Backend** — FastAPI (Python 3.11+) with the FalkorDB client. Agent loop: LLM plans → calls graph tools →
  collects evidence → writes findings + proposes actions → returns one typed JSON response. Hosted LLM
  behind an OpenAI-compatible endpoint (default: **Groq** `openai/gpt-oss-120b`; fully env-configurable).
  With no key, or if the provider fails, a rule-based investigator runs the same tools — the demo never
  depends on the LLM. Actions are derived by the server from evidence, never written by the model.
- **Database** — FalkorDB: Cypher over a property graph, native graph algorithms via `algo.*`, Redis-based.
  What-if simulations run on `GRAPH.COPY` forks — the live graph is only touched by analyst-confirmed actions.

**Agent tools** (implemented in `backend/agent/tools.py`; the model picks tools and fills
parameters, it never writes Cypher): `search_accounts`, `account_profile`, `shared_infrastructure`,
`detect_ring` (WCC + measured ringness), `money_trail` (SPpaths + time-ordering), `follow_funds`,
`rank_hubs` (PageRank), `layering_scan`, `laundering_capacity` (max-flow), `simulate_freeze`
(GRAPH.COPY fork), `plan_minimum_freeze` (min cut, proven on a fork). No API key or a provider
outage falls back to the rule-based investigator over the same tools.

---

## 4. Graph data model

Delivered by `backend/seed/generator.py` (fixed seed 42 — every run produces the identical world):
**595 accounts, 8,317 transfers, 585 devices, 581 IPs**.

**Nodes**

| Label | Properties | Notes |
|---|---|---|
| `Customer` | `id`, `name`, `segment` | synthetic owners |
| `Account` | `id` (e.g. `A17`), `type` (personal/business/merchant/external), `opened_at`, `country`, `status`, `anomaly_score` | `status` changes when the agent executes an action |
| `Device` | `id`, `kind` | enables shared-device pivots |
| `IPAddress` | `id`, `addr`, `asn_country` | enables shared-IP pivots |
| `Case`, `Investigation`, `Proposal`, `Action` | case store + audit trail | written only by the API, linked to the accounts they touched |

**Edges**

| Edge | Properties | Meaning |
|---|---|---|
| `OWNS` | `since` | Customer → Account |
| `TRANSFER` | `id`, `amount`, `ts` (epoch ms), `channel` + hidden ground truth (`ring_id`, `is_laundering` — read only by `seed/verify.py`) | directed money movement |
| `FLOWS_TO` | `capacity`, `tx_count`, `first_ts`, `last_ts` | one edge per ordered account pair (aggregated) — required by `algo.maxFlow`, which forbids parallel edges |
| `USED_DEVICE` / `USED_IP` | `last_seen` | account ↔ infrastructure |

**Planted structures** (asserted by `python -m seed.verify`, 17 checks, through the product's own tools):

1. between `case-001`'s — a 7-account mule ring (`A17 A22 A31 A47 A52 A63 A68`) cashing out at hub `H3`, capacity **$30,100**, minimum freeze **A47+A52** (a bypass runs through non-ring account `A77`);
2. `case-002` — a 4-hop fee-skimming chain `C42 → A91 → A33 → A75 → H1` completing in 26 minutes;
3. a third ring cashing out at `H5`, a benign family sharing a tablet (`case-004`), a benign high-volume merchant topping the legacy anomaly score (`case-003`), and hubs that sweep nightly to external exchange `X9`.

The seed script is committed for reproducibility and is re-run before every demo. The dataset is far under the FalkorDB Cloud free-tier 100 MB cap.

---

## 5. The demo scenarios

| Case | Alert | What the agent must show |
|---|---|---|
| `case-001` **Burst of transfers from A17** | 14 transfers from A17 within 2 hours to 12 recipients; most accounts opened <30 days ago | The 7-account ring (WCC over 3 shared devices + 2 IPs, 98% pass-through, ~13 min per hop), time-ordered trails to hub `H3` (fastest 36 min), capacity **$30,100**, and the minimum freeze **A47+A52** — proven on a graph copy — versus naive plans leaving 74% / 20% flowing |
| `case-002` **Follow the money** | Customer C42 reports an unauthorized $9,800 transfer | The chain `C42→A91→A33→A75→H1` in 26 minutes (3.5–3.6% skimmed per hop), shared device between the mules, freeze `A75` |
| `case-003` **The quiet merchant** | M8 flagged top-1% by the legacy anomaly score (volume) | **Honest false alarm:** 320 one-time customers, nothing passed on, no shared infrastructure with any ring → agent explains the score and proposes closing the alert |
| `case-004` **Shared-device cluster around A95** | Four accounts A95–A98 log in from the same tablet and IP | **Honest false alarm:** 34% pass-through over days (a household), no layering hits → agent proposes closing the alert |

Scenarios 3 and 4 are deliberate: an agent that only ever says "yes, fraud!" is a toy. A defensible
*no-evidence* answer is an integrity feature — and a memorable demo beat.

---

## 6. API contract (v1 summary — authoritative version: `backend/docs/api-contract.md`)

> **Update (Oct 16, v1.1):** the backend delivery refined the contract — the authoritative field
> list, new endpoints (`/api/cases`, `/api/cases/{id}/report`, `/api/evidence/replay`,
> `/api/queries`, `/api/investigate/stream`, `/api/admin/reseed`), evidence receipts, the
> rule-computed `conclusion`, the minimum-freeze actions and the full error-code table live in
> [`backend/docs/api-contract.md`](./backend/docs/api-contract.md), with real responses recorded in
> `frontend/lib/mocks/` and `backend/openapi.json` as the machine-readable schema. The section
> below is the original v1 summary, kept for context; defer to the contract doc on any difference.

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

1. **Case briefing** — case id chip, title, verdict badge (rule-computed `conclusion`:
   `suspicious activity` / `no evidence` / `inconclusive`; `partial` shown alongside), and the alert
   text that triggered the case.
2. **Question bar** — free-text input + **Investigate** button, plus per-case **suggested questions**
   (chips). In mock mode the first suggested question auto-runs on page load so the deployed shell
   demos itself.
3. **Live agent timeline** (while the agent works) — each graph step appears as it runs (plain-language name, algorithm badge, headline), elapsed counter. Streamed from `/api/investigate/stream`.
4. **Error banner** (rose) — error code, human message, **Retry** button.
5. **Main grid**
   - **Left: Transaction network** — route strip (the money trail in plain words + the freeze plan), the **3D network** (default; 2D Cytoscape on a switch / without WebGL) and a legend listing only what is on screen. The agent's conclusion now sits full-width above this grid.
   - **Right:**
     - **Agent summary** — the narrative + chips (asked question, model, tool-call count, latency).
     - **No-evidence banner** (sky blue) when `status: "no_evidence"`.
     - **Findings panel** — each finding: title, detail, confidence % + bar, and evidence chips.
     - **Evidence detail card** — appears on selection: id, type, producing tool, node/edge ids, raw
       `result_excerpt` JSON, and the **query receipts** (named query + params + Cypher, replayable).
     - **Proposed actions** — action cards with simulated-impact bars (capacity before vs after),
       residual routes, evidence chips, and a **Confirm / Run** button. Freeze actions update the
       canvas via the returned `graph_delta` and a snapshot refresh; the case report action links to
       the backend-generated markdown/JSON report.
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
| Shared-infrastructure cluster (`highlight.infrastructure_clusters`) | gray dashed border |
| Minimum freeze plan (`highlight.freeze_plan`) | violet dashed border (cut markers) |
| Capacity flows (`highlight.flows`) | sky-blue thick edges (max-flow pairs) |
| Money trail (`highlight.paths`) | amber node border + amber edges (`#f59e0b`) |
| Selected evidence emphasis | bright amber glow (node overlay + thick edges) |
| `USED_DEVICE` / `USED_IP` edges | dashed gray |
| Transfer amounts | edge labels when ≤ 30 transfers in view |
| Frozen accounts | slate/gray, dimmed |
| Layout | deterministic **preset** from `x_hint`/`y_hint` (main path, left → right); devices/IPs land at the barycenter of their neighbours; falls back to force layout if no hints |

### 7.3 Interactions

- Ask via free text (submit) or a suggested-question chip → new investigation.
- Click a finding → graph emphasizes **all of its evidence**; click a specific evidence chip → tight
  emphasis of exactly that evidence's `node_ids`/`edge_ids` + the evidence detail card opens.
- Confirm/Run an action → `POST /api/actions/execute` → card flips to green **executed**; the canvas
  applies the returned `graph_delta` and refreshes from `GET /api/graph/snapshot` (live mode writes to
  the graph; mock mode replays the recorded responses and remembers freezes per case).
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

`NEXT_PUBLIC_API_BASE_URL=mock` (the default) replays real backend recordings for four scenarios
(`case-001`–`case-004`) from `frontend/lib/mocks/` with ~1.1 s simulated latency. The recordings are
**contract v1.1** — recorded from the FastAPI backend, kept in sync with
`backend/docs/api-contract.md`. Mock `executeAction` remembers freezes per case, so the post-freeze
follow-up ("Is there any way around this freeze?") replays the after-freeze recording. To go live,
point the variable at the FastAPI service; no component changes are needed.

---

## 8. Repository layout

| Path | What it is | Owner |
|---|---|---|
| `plan.md` | **This document** — single source of truth | both |
| `frontend/` | Next.js investigation console (mock-first) | frontend lead |
| `backend/` | FastAPI agent loop + FalkorDB tool layer + seed generator + 27 tests | AI/backend lead |
| `backend/docs/api-contract.md` | Authoritative API contract v1.1 + changelog | both |
| `queries/` | Annotated Cypher the backend runs by name (submission requirement) | AI/backend lead |
| `render.yaml`, `docker-compose.yml` | Render blueprint + local FalkorDB | AI/backend lead |
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

### Backend (live in Phase 1 — verified Oct 16)

```bash
# FalkorDB — Colima (headless Docker runtime) + the repo's compose file
colima start                             # first run boots a small VM
docker compose up -d                     # FalkorDB on :6379, Browser on :3080

# Backend (Python 3.11+; a venv already exists at backend/.venv on this machine)
cd backend
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                     # add LLM_API_KEY for Groq, or leave empty for rule-based mode

python -m seed.load --verify             # rebuild the demo graph, run the 17 ground-truth checks
uvicorn app.main:app --reload --port 8000
pytest -q                                # 27 tests (uses graph "ftm_test", never the demo graph)
```

> Docker note: the frontend machine runs **Colima** (`brew install colima docker docker-compose`)
> instead of Docker Desktop — no license prompt, CLI-only. Run `docker compose up -d` from the repo
> root; `colima stop` releases the VM when it is not needed.

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
| Frontend | **Vercel** (Hobby) — live at `graph-hacks-cyan.vercel.app` | root directory `frontend/`; env: `NEXT_PUBLIC_API_BASE_URL` + `NEXT_PUBLIC_BACKEND_API_TOKEN` (rebuild needed after any change) |
| Backend | **Render** (free tier) — live at `follow-the-money-api.onrender.com` | cold start ~50 s after ~15 min idle — warm before any demo; `BACKEND_API_TOKEN` is Render-generated; CORS allows the Vercel origin |
| Database | **FalkorDB Cloud free tier** (AWS ap-south-1; credentials in `backend/.env.cloud`, git-ignored) + **local Docker** for dev | Cloud limits: 100 MB, no TLS, no backups, stopped after 1 day idle, deleted after 7 days → the seed is committed, so the DB is always reproducible |

**Demo-day protocol (repeat before every rehearsal and the real run):**

1. **Reseed the cloud database** — never demo on mutated state:
   ```bash
   cd backend
   set -a; source .env.cloud; set +a    # `set -a` matters: without it the seed silently falls back to localhost
   python -m seed.load --verify         # 17/17 checks, ~10 s
   ```
2. **Warm the backend** — `curl -s https://follow-the-money-api.onrender.com/api/health` until `db: ok`
   (~50 s if asleep), then confirm the status pill is green at `graph-hacks-cyan.vercel.app`.
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

- [x] Seed generator + FalkorDB loader; seed committed for reproducibility (595 accounts, seed 42, `seed.load --verify` = 17 checks)
- [x] Tool layer: 11 tools incl. `detect_ring` (WCC), `money_trail` (SPpaths), `rank_hubs`, `layering_scan`, `laundering_capacity`, `plan_minimum_freeze` (min cut on a `GRAPH.COPY` fork)
- [x] Agent loop + LLM wiring (Groq default, env-configurable) with rule-based fallback; `POST /api/investigate` + SSE + actions/cases/health/report/replay endpoints return the contract shape
- [x] Contract v1.1 documented (`backend/docs/api-contract.md`) + real fixtures delivered to `frontend/lib/mocks/`
- [x] Frontend migrated to contract v1.1 (types, mocks, api client, canvas highlights, action execution → snapshot refresh)
- [x] Docker runtime on the frontend machine — **Colima installed Oct 16** (`brew install colima docker docker-compose`; FalkorDB + Browser via `docker compose up -d`, Browser on :3080)
- [x] Frontend ⇄ backend integration verified live: `seed.load --verify` 17/17, `pytest` 27/27, headless-browser pass 21/21 (case-001 burst → freeze A47+A52 → follow-up "no route remains"; case-002/003/004)
- [x] **M1 (Day 2, 21:00): one scenario live end-to-end** — all four scenarios run live; full rehearsal protocol still scheduled before M2

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
| D6 | API contract | ✅ | v1.1 delivered Oct 16 (`backend/docs/api-contract.md`); recorded responses in `frontend/lib/mocks/`, schema in `backend/openapi.json` |
| D7 | Responsibilities | 🟡 | Frontend = UI/viz/deploy/video; backend = seed/tools/agent/README tech sections |
| D8 | Accounts, keys, budget | 🟡 | Each owns accounts; LLM key lives in backend env; $0 spend without agreement |
| D9 | Integration timing | 🟡 | M1 Day 2 21:00; M2 Day 3 21:00; mock-first in between |
| D10 | Deployment path + demo posture | 🟡 | Vercel + Render + Cloud; submit by Sun 20:00; video fallback |
| D11 | Testing/docs/submission plan | 🟡 | Phase 3 checklist (§11) |
| D12 | Network visual | 🟡 | 3D by default (two floors: money moving left → right above, shared phones/IPs below); Cytoscape 2D kept as a switch + WebGL fallback (Oct 16) |
| D14 | Demo UX | 🟡 | Dark "investigation room" default; live agent timeline (SSE) → verdict hero with numbers → graph assembles step by step → freeze moment (capacity drains, "Route cut") → proof strip with algorithm badges; landing hero with the live case-001 network (Oct 16) |
| D13 | Free-tier LLM | 🟡 | Token-lean loop (~8K/investigation) + retry-after wait + Groq → Gemini fallback; rule-based only if every provider fails (Oct 16) |

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
| No Docker installed yet (frontend machine) | Blocks Phase 1 setup | **Resolved Oct 16** — Colima installed (`colima start` + `docker compose up -d`); runbook in §9 |
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
