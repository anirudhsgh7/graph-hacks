# Follow the Money — frontend

Next.js investigation console for the Graph Hacks "Follow the Money" AML agent (Track 1).
Runs **mock-first**: by default it replays the frozen fixtures in `lib/mocks/`, so you can build
and demo the UI without any backend.

```bash
npm install
npm run dev        # http://localhost:3000
```

- `NEXT_PUBLIC_API_BASE_URL=mock` (default, see `.env.example`) → frozen fixtures.
- `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` → live FastAPI backend (`plan.md` §6 in the repo root describes every endpoint and payload).

Key pieces:

- `lib/types.ts` — the API contract as TypeScript types (source of truth for the UI).
- `lib/api.ts` — typed client: investigate / execute action / graph snapshot / health.
- `lib/mocks/` — scenario 1–3 fixtures (ring bust, money trail, honest false alarm).
- `components/GraphCanvas.tsx` — Cytoscape graph with ring/trail/evidence highlighting.
- `components/CaseView.tsx` — the investigation console: ask → findings → evidence → actions.

Deploy: import the repo in Vercel (root directory `frontend/`), set `NEXT_PUBLIC_API_BASE_URL` to the backend URL.
Use a **personal** GitHub account repo — Vercel's Hobby plan cannot connect org-owned repositories.
