# AGENTS.md

**Hackathon repo** — Graph Hacks: Context for AI Agents (WeMakeDevs × FalkorDB; deadline Oct 18, 2026, 23:59 IST). An agent-driven AML investigation console where FalkorDB graph algorithms are the product, not decoration.

**`plan.md` is the single source of truth** — read it before planning any work. It holds the frozen API contract (§6), UI spec (§7), demo scenarios (§5), phased plan (§11), and decision log (§12). `README.md` only points to it.

## Layout & lanes

- `frontend/` — Next.js 16.4 + Tailwind v4 + Cytoscape; the only code in the repo, fully working in mock mode.
- `backend/`, `queries/` — planned, not yet present; owned by the backend teammate. Don't create or modify them unless asked.
- API contract v1 is mirrored as types in `frontend/lib/types.ts`; breaking changes need both teammates' sign-off (see `plan.md` §6).

## Commands (run inside `frontend/`)

- `npm run dev` — Turbopack dev server on :3000
- `npm run build` — production build; also runs the typecheck
- `npx tsc --noEmit` — fast standalone typecheck
- `npm run lint` — ESLint (the script calls `eslint` directly; there is no `next lint` in Next 16)
- No test suite exists. Verification = typecheck + lint + headless screenshot pass (below).

## Next.js 16 quirks (this version is newer than LLM training data)

- Read `frontend/node_modules/next/dist/docs/` before writing Next.js code — APIs and conventions differ from older releases.
- `frontend/AGENTS.md` is auto-generated and re-added by `next dev`; don't delete it or "clean it up" in diffs.
- `cacheComponents: true` in `next.config.ts`: dynamic route params must be passed as a promise into `<Suspense>` (pattern in `app/case/[id]/page.tsx`); client components unwrap with `use()`.
- Tailwind v4 runs via the `@tailwindcss/turbopack` loader in `next.config.ts` (not PostCSS) — don't remove that config.

## Mock mode — the default data path

- `frontend/.env.local` sets `NEXT_PUBLIC_API_BASE_URL=mock`, which replays fixtures from `frontend/lib/mocks/` (~900 ms simulated latency); set a URL to hit the live FastAPI backend. Restart the dev server after editing env (builds inline `NEXT_PUBLIC_*`).
- The fixtures are contract-conformant examples **and** the backend's implementation target — keep them in sync with `plan.md` §6.
- In mock mode `/case/[id]` auto-runs the first suggested question on load, so a plain page load renders the full flow (findings, evidence, graph, trace).

## Frontend conventions

- Reuse the component classes from `app/globals.css`: `.card`, `.chip`, `.btn`, `.btn-primary`, `.input`, `.skeleton`.
- Graph colors/shapes/highlight semantics are specified in `plan.md` §7.2 (rose = ring, amber = trail, slate = frozen) — match them.
- Cytoscape v3.34 gotcha: it injects `.__________cytoscape_container { position: relative; }`, which defeats `absolute inset-0` on its container — size the graph container explicitly (`h-full w-full`, see `components/GraphCanvas.tsx`).
- `@types/cytoscape`: annotate style arrays as `StylesheetJson`; some runtime-valid numeric style props (e.g. `text-background-padding`) are mistyped as string-only — avoid them.

## Verifying UI changes

- `curl` proves nothing — the app is client-rendered and the graph is a canvas. Use a headless screenshot pass: `puppeteer-core` (install into a temp dir, never the repo) driving Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Check the page for console errors; in mock mode `/case/case-001` shows findings + graph + trace with zero interaction.

## Git conventions

- Small, scoped commits (one concern each); prefer explicit paths over `git add .` — check `git status` first.
- Keep `.env.example` updated when adding variables; never commit real keys (`.env*` is gitignored except the examples).
