# Follow the Money

**An agent-driven AML investigation console where FalkorDB graph algorithms are the product — not decoration.**

**Track 1 — Agents That Act on Connected Data** · [Graph Hacks: Context for AI Agents](https://www.wemakedevs.org/hackathons/falkordb) (WeMakeDevs × FalkorDB, Oct 15–18, 2026) · built by a team of two

> **Live demo:** [graph-hacks-cyan.vercel.app](https://graph-hacks-cyan.vercel.app) ⟷ [follow-the-money-api.onrender.com/api/health](https://follow-the-money-api.onrender.com/api/health) ⟷ FalkorDB Cloud
> **Demo video:** _link added at submission_
> **Docs:** [`plan.md`](./plan.md) (single source of truth: architecture, UI, demo script) · [`backend/docs/api-contract.md`](./backend/docs/api-contract.md) (API contract v1.3)

An analyst opens an alert ("14 transfers from account A17 in two hours") and asks a question in
plain English. The agent works the transaction graph in FalkorDB — uncovering mule rings through
shared phones and IPs, reconstructing time-ordered money trails, measuring how much money the
network can move — and then answers the question an AML team actually has to decide on:

> *Freeze 2 accounts (A47, A52) — not 7. That cuts every route to the cash-out hub. Proven: the
> graph was copied, the two accounts removed, the algorithms re-run — capacity $30,100 → $0, zero
> routes left. Freezing the alerted account alone would leave 74% flowing; freezing the obvious
> aggregator would leave 20% flowing through A77, an account that is not even in the ring.*

Every sentence links to evidence, every piece of evidence carries the exact Cypher that produced it
(replayable), and a rule over graph measurements — not the model — decides the verdict.

## Why FalkorDB is load-bearing (rule 3: the graph must do real work)

Remove FalkorDB and nothing is left: no ring, no trail, no capacity, no freeze plan, no proof.

| Capability | Graph operation | FalkorDB |
|---|---|---|
| Mule-ring discovery | Components of the account–device–IP graph | **`algo.WCC`** |
| Money-trail reconstruction | Shortest routes between accounts | **`algo.SPpaths`** over `FLOWS_TO` |
| Cash-out hub ranking | Influence over transfers | **`algo.pageRank`** |
| Laundering capacity | Max-flow from entry mules to the cash-out hub | **`algo.maxFlow`** (native on current builds; identical Python solver on `FLOWS_TO` otherwise) |
| Minimum freeze, proven | Copy graph → delete accounts → re-run algorithms | **`GRAPH.COPY`** forks + a min-vertex-cut planner |
| Shared-infrastructure pivots | Multi-hop pattern matching | Cypher `(a)-[:USED_DEVICE\|USED_IP]->(x)<-...-(b)` |
| Layering / pass-through scan | Temporal path patterns | Cypher with time-window predicates |
| Case store, audit trail, memory | `Case`/`Investigation`/`Proposal`/`Action` nodes + `(:Investigation)-[:ABOUT]->(:Account)` | Cypher writes, linked to the accounts they touched |
| Every answer’s receipts | The named query + params behind each evidence item | `GET /api/queries`, replayable via `POST /api/evidence/replay` |

The signature move is not a lookup: **minimum vertex cut** has no FalkorDB procedure, so the planner
solves it in Python over `FLOWS_TO` edges read from FalkorDB (with a collateral cost — freezing a
busy legitimate account counts expensive), then **proves the plan inside FalkorDB on a fork**: copy
the graph, delete the recommended accounts, re-run `algo.maxFlow` and `algo.SPpaths`, drop the copy.

## Graph data model

All data is synthetic (seed 42, `backend/seed/generator.py`): **595 accounts, 8,317 transfers,
585 devices, 581 IPs** — regenerated identically on every reseed.

**Nodes**

| Label | Key properties | Purpose |
|---|---|---|
| `Customer` | `id`, `name`, `segment` | synthetic owners |
| `Account` | `id` (e.g. `A17`), `type` (personal/business/merchant/external), `opened_at`, `country`, `status` (active/flagged/**frozen**), `anomaly_score` (legacy rules score) | the money lives here |
| `Device` | `id`, `kind` | shared-device pivots |
| `IPAddress` | `id`, `addr`, `asn_country` | shared-network pivots |
| `Case`, `Investigation`, `Proposal`, `Action` | case store + audit trail + memory | written only by the API |

**Relationships**

| Type | Direction | Properties |
|---|---|---|
| `OWNS` | Customer → Account | `since` |
| `TRANSFER` | Account → Account | `id`, `amount`, `ts` (epoch ms), `channel` + hidden ground truth `ring_id`/`is_laundering` (read only by `seed/verify.py`, never by the product) |
| `FLOWS_TO` | Account → Account | `capacity` (total money on the pair), `tx_count`, `first_ts`, `last_ts` |
| `USED_DEVICE` / `USED_IP` | Account → Device / IPAddress | `last_seen` |
| `HAS_INVESTIGATION`, `PROPOSES`, `HAS_ACTION`, `TARGETS`, `ABOUT` | case store / memory | links investigations to the cases and accounts they are about |

`FLOWS_TO` is one edge per ordered account pair, aggregated from `TRANSFER` — it exists because
`algo.maxFlow` requires a relationship type without parallel edges, and real transfer data has many
payments between the same two accounts.

**Planted structures** (asserted through the product’s own tools by `python -m seed.verify` — 17 checks):

1. a 7-account mule ring (`A17 A22 A31 A47 A52 A63 A68`) cashing out at hub `H3`, capacity
   **$30,100**, minimum freeze **A47+A52** — with a bypass route through non-ring account `A77`;
2. a 4-hop fee-skimming chain `C42 → A91 → A33 → A75 → H1` completing in 26 minutes;
3. a third ring cashing out at `H5`, hubs that sweep nightly to external exchange `X9`, a benign
   family sharing a tablet, and a busy merchant that tops the legacy anomaly score.

## The Cypher queries and graph algorithms the product depends on

Every query the product runs lives in [`queries/`](./queries/) as annotated Cypher, loaded **by
name** from `backend/graph/queries.py`. The model never writes or sees a query — it picks from 11
fixed tools and fills parameters; the folder is therefore exactly what runs, and `GET /api/queries`
lists it live.

| File | What it contains |
|---|---|
| `00_seed.cypher` | indexes and bulk loaders |
| `01_accounts.cypher` | account search/profile, anomaly rank, transfer history, capability probe |
| `02_rings.cypher` | shared-infrastructure pivots, **`algo.WCC`** components, **layering pattern** (money in→out within a window) |
| `03_trails.cypher` | **`algo.SPpaths`** routes, the transfers behind each hop, forward tracing of one payment |
| `04_flow.cypher` | **`algo.pageRank`**, **`algo.maxFlow`**, paged `FLOWS_TO` reads, counterparty volumes, fork edit (`fork_remove_accounts`) |
| `05_console.cypher` | case store, proposals, freeze/flag writes, audit trail, canvas subgraph, **recall** of other cases’ investigations/actions |

Each evidence item in every response carries its receipts (query name + params + the Cypher), so a
judge can paste the same query into FalkorDB Browser, or press replay (`POST /api/evidence/replay`,
read-only queries only, returns a fingerprint of the rows).

## Demo scenarios (planted ground truth)

| Case | Question | What the agent shows |
|---|---|---|
| `case-001` | "Who is behind this burst of transfers?" | the 7-account ring (3 shared phones, 2 IPs, 98% pass-through, ~13 min per hop), time-ordered trails to `H3`, capacity **$30,100**, **minimum freeze A47+A52** vs 74% / 20% left by the naive plans |
| `case-001` follow-up | "Is there any way around this freeze?" | no route remains; capacity → **$0** |
| `case-002` | "Follow the $9,800 from C42." | `C42 → A91 → A33 → A75 → H1` in 26 minutes, 3.5–3.6% skimmed per hop; freeze **A75** |
| `case-003` | "Is M8 laundering money?" | **No evidence** — the #1 anomaly score explained by 320 one-time customers; nothing is passed on; recommends closing the alert |
| `case-004` | "Is the A95 cluster a mule ring?" | **No evidence** — a household sharing a tablet; 34% pass-through over days, not minutes |

Scenarios 3 and 4 are honest false alarms on purpose: an agent that only ever says “fraud!” is a toy.

## How one investigation runs

```
alert → analyst question → agent picks graph tools → evidence-linked findings
      → proposed actions with simulated impact → analyst confirms → the graph changes
```

1. **Tools** (`backend/agent/tools.py`): 11 fixed, parameterised tools. The model selects tools and
   fills parameters; it has no write access and never composes Cypher.
2. **Evidence** (`agent/evidence.py`): every tool registers what it saw (`ev-1`, `ev-2`, …) with node
   ids, edge ids, key numbers and query receipts.
3. **Verdict** (`agent/summarize.py`): a fixed rule over graph measurements — `suspicious` if a mule
   ring was measured, a payment was traced through ≥3 fee-skimming hops, or ≥5 pass-through
   transfers were found; otherwise `no_evidence`. **The model's conclusion cannot override it.**
4. **Narrative**: the model's findings are kept only if they cite real evidence ids, agree with the
   verdict, and pass the graph fact check (`agent/factcheck.py`: every account id and dollar amount
   in the prose must exist in the results — invented claims fall back to deterministic text).
5. **Graph honesty**: unknown account ids in a question are refused (`NOT_IN_GRAPH`, 404) before any
   query or model call; each stored investigation is linked to its accounts
   (`(:Investigation)-[:ABOUT]->(:Account)`) and cross-case recall feeds the next investigation.
6. **Actions** (`agent/actions.py`): derived server-side from evidence, each with a simulation for
   freezes; nothing changes until the analyst confirms with the action token.

The agent loop has no framework — `backend/agent/loop.py` is one readable file. With no LLM key, or
if every provider fails/rate-limits, a deterministic rule-based investigator runs the same tools and
returns the same contract (`meta.mode: rule_based`) — the demo can never depend on a third party.
Simulations never touch live data: they run on `GRAPH.COPY` forks, and “money movement” tools always
reason over the graph *as money can move today* (frozen accounts excluded).

## Run it

### A. The hosted demo (no setup)

- Frontend: <https://graph-hacks-cyan.vercel.app> — the case board → open `case-001` (it auto-runs)
- API health: <https://follow-the-money-api.onrender.com/api/health> (free tier: ~50 s cold start)

### B. Full local stack (backend + FalkorDB + frontend)

Prerequisites: Docker (or Colima), Python 3.11+, Node 20+.

```bash
# 1. FalkorDB on :6379 (FalkorDB Browser on :3080)
docker compose up -d                      # from the repo root

# 2. Backend
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                      # optional: add LLM_API_KEY (any OpenAI-compatible
                                          # endpoint) — leave empty for rule-based mode
python -m seed.load --verify              # build the demo graph; 17/17 ground-truth checks
uvicorn app.main:app --reload --port 8000 # API at http://localhost:8000, docs at /docs

# 3. Frontend (another terminal)
cd frontend
npm install
npm run dev                               # http://localhost:3000
```

Point the frontend at the local API by setting `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` in
`frontend/.env.local` (restart the dev server after editing). Without it — or with `=mock` — the
frontend replays recorded backend responses from `frontend/lib/mocks/`, so the UI runs end-to-end
with no database at all.

Try an investigation straight from the shell:

```bash
curl -s -X POST localhost:8000/api/investigate -H 'Content-Type: application/json' \
  -d '{"question":"Who is behind this burst of transfers?","case_id":"case-001"}' | jq '.conclusion, .summary'
```

### Verify it

```bash
cd backend && pytest -q        # 45 tests (case store, scenarios, LLM loop against a fake
                               # OpenAI-compatible server, fact-check, flow solver, forks)
cd frontend && npm run build   # production build + typecheck   (npm run lint too)
```

### Deploy your own

The repo ships a Render blueprint: [`render.yaml`](./render.yaml) builds the API, and
`docker-compose.yml` runs the database locally. In production, reseed the cloud graph before every
demo — full protocol in [`plan.md`](./plan.md) §10. All environment variables are listed in
[`.env.example`](./.env.example).

## Repository layout

| Path | What it is |
|---|---|
| `plan.md` | single source of truth: architecture, UI spec, demo script, phases, decisions |
| `frontend/` | Next.js 16 console: streamed agent timeline, verdict hero, 3D transaction network (+Cytoscape 2D), dark/light |
| `backend/` | FastAPI agent loop + FalkorDB tool layer + seed generator + 45 tests |
| `queries/` | the annotated Cypher the product runs, loaded by name (submission requirement) |
| `backend/docs/api-contract.md` | API contract v1.3 + changelog; real recorded responses under `frontend/lib/mocks/` |

## AI-assistant disclosure (rule 11)

This project was built inside the hackathon window with **AI coding assistants** (Anthropic’s
Claude and an OpenCode-based agent) used as development tools. Both team members directed the work,
reviewed and edited every change, and can explain the graph model, the queries, the architecture and
the technical decisions behind them (rule 12). The runtime also uses a hosted LLM (via OpenRouter) —
it only **selects tools and writes the narrative**; verdicts, findings, actions and the graph
evidence are computed by deterministic code over FalkorDB measurements, and the product runs without
the model at all (`meta.mode: rule_based`).

---

_Follow the Money — Graph Hacks, October 2026. Synthetic data only; no real persons or accounts._
