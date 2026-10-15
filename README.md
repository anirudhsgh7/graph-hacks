# Graph Hacks — Follow the Money (Track 1)

Agent-driven AML investigation console built for **Graph Hacks: Context for AI Agents**
(WeMakeDevs × FalkorDB, October 15–18, 2026). FalkorDB is the context layer — not decoration:

- ring detection → `algo.WCC` over shared devices/IPs, then pass-through measurement
- money trails → `algo.SPpaths`, kept only when real transfers follow them in time order
- hub ranking → `algo.pageRank`
- capacity + minimum freeze → `algo.maxFlow` + a min-vertex-cut planner, proven by re-running
  the algorithms on a `GRAPH.COPY` fork before anything is frozen

> **Status:** Day 2 — the backend (seed + tools + agent + tests) is delivered; the frontend runs
> end-to-end in mock mode against the recorded backend responses and flips to live with one env var.
>
> **📄 Everything about this project lives in [`plan.md`](./plan.md)** — architecture, data model,
> API contract, UI guide, demo scenarios, and the phase-by-phase build plan. The authoritative API
> contract is [`backend/docs/api-contract.md`](./backend/docs/api-contract.md).

## Repository layout

| Path | What it is | Owner |
|---|---|---|
| `plan.md` | Single source of truth: project, UI, API contract, phases | both |
| `frontend/` | Next.js investigation console (mock-first, contract v1.1) | frontend lead |
| `backend/` | FastAPI agent loop + FalkorDB tool layer + seed generator | AI/backend lead |
| `queries/` | Annotated Cypher the product runs (loaded by name; submission requirement) | AI/backend lead |
| `backend/docs/api-contract.md` | API contract v1.1 + changelog | both |
| `render.yaml`, `docker-compose.yml` | Deploy blueprint (Render) and local FalkorDB | both |
| `.env.example` | Every environment variable across the repo | both |

## Run the frontend right now (no backend needed)

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000, or :3001 if FalkorDB Browser is up
```

Mock mode is the default (`NEXT_PUBLIC_API_BASE_URL=mock`), replaying the four scripted scenarios
(ring burst / money trail / two honest false alarms) from `frontend/lib/mocks/` — real recordings
of the backend responses.

## Run the backend + database (live mode)

```bash
docker compose up -d                      # FalkorDB on :6379, FalkorDB Browser on :3080

cd backend
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                      # add LLM_API_KEY for Groq, or leave empty for rule-based mode

python -m seed.load --verify              # build the demo graph, run the ground-truth checks
uvicorn app.main:app --reload --port 8000 # API at http://localhost:8000, docs at /docs
pytest -q                                 # 27 tests against the running FalkorDB
```

Then set `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` in `frontend/.env.local` (and
`NEXT_PUBLIC_BACKEND_API_TOKEN` if the backend sets `BACKEND_API_TOKEN`) and restart the dev server.
The deployed stack: frontend on Vercel, backend on Render (`render.yaml`), database on
FalkorDB Cloud (reseeded before every demo).

## AI-assistant disclosure (hackathon rule 11)

This project is built with the help of AI coding assistants; all code is reviewed, understood and
explained by the team members. Final disclosure wording ships in the submission README.
