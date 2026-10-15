# Graph Hacks — Follow the Money (Track 1)

Agent-driven AML investigation console built for **Graph Hacks: Context for AI Agents**
(WeMakeDevs × FalkorDB, October 15–18, 2026). FalkorDB is the context layer — not decoration:

- ring detection → `algo.labelPropagation` (community detection over transfers + devices + IPs)
- money trails → `algo.SPpaths` (shortest paths from victim accounts to cash-out hubs)
- hub ranking → `algo.pageRank` (influence on directed transfers)
- freeze impact → `algo.maxFlow` re-run with frozen nodes excluded (the agent *acts* on the graph)

> **Status:** Day 1 — the frontend console runs end-to-end in mock mode; the backend (`backend/`) is in progress.
>
> **📄 Everything about this project lives in [`plan.md`](./plan.md)** — architecture, data model,
> API contract, UI guide, demo scenarios, and the phase-by-phase build plan.

## Repository layout

| Path | What it is | Owner |
|---|---|---|
| `plan.md` | Single source of truth: project, UI, API contract, phases | both |
| `frontend/` | Next.js investigation console (mock-first) | frontend lead |
| `backend/` | FastAPI agent loop + FalkorDB tool layer + seed generator | AI/backend lead |
| `queries/` | Annotated Cypher the product depends on (submission requirement) | AI/backend lead |
| `.env.example` | Every environment variable across the repo | both |

## Run the frontend right now (no backend needed)

```bash
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Mock mode is the default (`NEXT_PUBLIC_API_BASE_URL=mock`), replaying the three scripted scenarios
(ring burst / money trail / honest false alarm) from `frontend/lib/mocks/`.

## Going live (once the backend exists)

Set `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` (dev) or the deployed backend URL (Vercel env var).
The contract is frozen in `plan.md` §6 — the frontend builds against it, the backend implements it.

## AI-assistant disclosure (hackathon rule 11)

This project is built with the help of AI coding assistants; all code is reviewed, understood and
explained by the team members. Final disclosure wording ships in the submission README.
