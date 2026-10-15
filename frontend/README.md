# Follow the Money — frontend

Next.js investigation console for the Graph Hacks "Follow the Money" AML agent (Track 1).
Runs **mock-first**: by default it replays the frozen fixtures in `lib/mocks/`, so you can build
and demo the UI without any backend.

```bash
npm install
npm run dev        # http://localhost:3000 (use -- -p 3001 when FalkorDB Browser has :3000)
```

- `NEXT_PUBLIC_API_BASE_URL=mock` (default, see `.env.example`) → replays recorded backend responses.
- `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` → live FastAPI backend (see
  `backend/docs/api-contract.md` for every endpoint and payload, or use the repo root's plan.md §6 for context).
- Set `NEXT_PUBLIC_BACKEND_API_TOKEN` to the backend's `BACKEND_API_TOKEN` when that is configured
  (required for `POST /api/actions/execute`).

Key pieces:

- `lib/types.ts` — the API contract v1.1 as TypeScript types (source of truth for the UI).
- `lib/api.ts` — typed client: investigate / execute action / graph snapshot / cases / health (+ mock switch).
- `lib/mocks/` — real recordings for the four scenarios (burst ring + minimum freeze, money trail,
  merchant false alarm, shared-device household).
- `components/GraphCanvas.tsx` — Cytoscape graph: ring / trail / minimum-freeze (cut) / flow highlighting.
- `components/CaseView.tsx` — the investigation console: ask → findings → evidence → receipts → actions.

Deploy: import the repo in Vercel (root directory `frontend/`), set `NEXT_PUBLIC_API_BASE_URL` to the backend URL.
Use a **personal** GitHub account repo — Vercel's Hobby plan cannot connect org-owned repositories.
