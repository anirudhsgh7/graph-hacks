# AGENTS.md

**Hackathon repo** — Graph Hacks: Context for AI Agents (WeMakeDevs × FalkorDB; deadline Oct 18, 2026, 23:59 IST). An agent-driven AML investigation console where FalkorDB graph algorithms are the product, not decoration.

**`plan.md` is the single source of truth** — read it before planning any work. It holds the API contract summary (§6), UI spec (§7), demo scenarios (§5), phased plan (§11), and decision log (§12). The authoritative API contract is `backend/docs/api-contract.md` (v1.1) with real responses under `frontend/lib/mocks/`.

## Layout & lanes

- `frontend/` — Next.js 16.4 + Tailwind v4 + **3d-force-graph / three.js** (default 3D network) + Cytoscape (2D fallback); runs end-to-end in mock mode against recorded backend responses. Owned by the frontend lead.
- `backend/` — FastAPI agent loop + FalkorDB tool layer + deterministic seed. Owned by the backend teammate; don't change its behavior without a reason tied to the UI contract.
- `queries/` — the annotated Cypher the product runs, loaded by name from `backend/graph/queries.py`; submission requirement. `render.yaml` and `docker-compose.yml` live at the repo root.
- API contract v1.1 is mirrored as types in `frontend/lib/types.ts`; breaking changes need both teammates' sign-off (see `backend/docs/api-contract.md` changelog).

## Commands

Frontend (run inside `frontend/`):

- `npm run dev` — Turbopack dev server on :3000 (FalkorDB Browser is remapped to :3080 in `docker-compose.yml`)
- `npm run build` — production build; also runs the typecheck
- `npx tsc --noEmit` — fast standalone typecheck
- `npm run lint` — ESLint (the script calls `eslint` directly; there is no `next lint` in Next 16)
- No test suite exists. Verification = typecheck + lint + headless screenshot pass (below).

Backend (run inside `backend/`; FalkorDB via Colima + the repo's `docker-compose.yml`):

- `colima start && docker compose up -d` (repo root) — FalkorDB on `:6379`, Browser on `:3080`
- `python -m seed.load --verify` — rebuild the demo graph + ground-truth checks (16, or 17 on FalkorDB builds with native `algo.maxFlow`)
- `uvicorn app.main:app --reload --port 8000` — the API (CORS defaults to `http://localhost:3000`, `backend/.env` adds `:3100`)
- `pytest -q` — 34 tests; needs the running FalkorDB (uses graph `ftm_test`, never the demo graph)

Hosted demo (deployed): Vercel `graph-hacks-cyan.vercel.app` ⟷ Render `follow-the-money-api.onrender.com` ⟷ FalkorDB Cloud. Reseed the cloud DB with `set -a; source .env.cloud; set +a` then `python -m seed.load --verify` (the `set -a` is required — without it the seed silently hits localhost); full protocol in `plan.md` §10. Render pins the LLM config as well — `LLM_BASE_URL`/`LLM_MODEL` carry Groq values in `render.yaml`, and `LLM_API_KEY` is `sync: false` (dashboard-set); switching providers there means overriding all three.

## Backend: deterministic by default, LLM optional

- With `LLM_API_KEY` set, the model drives tool choice in `backend/agent/loop.py` (defaults: Groq, `openai/gpt-oss-120b` — see `backend/.env.example`); without it a deterministic planner runs the same query layer (`meta.mode: rule_based`). Both serve the same API contract.
- Loop invariants — don't regress them: findings must cite valid evidence, the graph-measured verdict overrides the model's, and *any* LLM failure (rate limit, outage, invalid answer) discards the partial run so the full deterministic investigator completes it. Never ship partial findings.
- Free-tier budget (Oct 16 fix): the model sees compact *digests* of tool results (`backend/agent/digest.py`), calls independent tools in parallel, and writes its JSON answer in its last turn — a full investigation is ~8K input tokens (was ~17.5K; guarded by `test_token_budget_of_a_full_investigation`). On a 429 with a short retry-after the session waits (`LLM_MAX_WAIT_S`); otherwise it switches to the fallback provider (`LLM_FALLBACK_*`, Gemini's OpenAI-compatible endpoint by default) for the rest of that investigation. Only when every provider fails does the full deterministic investigator run. `meta.notes` records waits and switches; `meta.model` is the model actually used.
- `backend/tests/test_agent_llm.py` drives the loop against a scripted fake OpenAI-compatible server (`tests/fake_llm.py`) — no real key needed; extend those cases when touching the loop.

## Next.js 16 quirks (this version is newer than LLM training data)

- Read `frontend/node_modules/next/dist/docs/` before writing Next.js code — APIs and conventions differ from older releases.
- `frontend/AGENTS.md` is auto-generated and re-added by `next dev`; don't delete it or "clean it up" in diffs.
- `cacheComponents: true` in `next.config.ts`: dynamic route params must be passed as a promise into `<Suspense>` (pattern in `app/case/[id]/page.tsx`); client components unwrap with `use()`. URL data follows the same rule — `usePathname()` outside `<Suspense>` fails the build with `CLIENT_HOOK_DYNAMIC` (pattern in `components/ShellNav.tsx`).
- Tailwind v4 runs via the `@tailwindcss/turbopack` loader in `next.config.ts` (not PostCSS) — don't remove that config.
- **Stale dev CSS**: after editing `app/globals.css`, a long-running `next dev` can keep serving the old compiled CSS (loader cache) — restart the dev server before trusting the rendered page; production builds always recompile.
- ESLint flags `react-hooks/set-state-in-effect`: the classic `useEffect(() => setMounted(true))` mount gate is banned. Use `useSyncExternalStore` for client-only flags (pattern in `components/ThemeToggle.tsx`).
- **Dark is the default** when nothing is saved (the "investigation room" look); the toggle saves light/dark. Theme is class-based on `<html>` (`.dark`), applied before first paint by an inline script defined in `lib/theme.ts` and rendered in `app/layout.tsx`; keep its logic in sync with `components/ThemeProvider.tsx` and never render server/client-divergent theme markup (icons gate via CSS, labels via the hydration flag).

## Mock mode — the default data path

- `frontend/.env.local` sets `NEXT_PUBLIC_API_BASE_URL=mock`, which replays fixtures from `frontend/lib/mocks/` (real backend recordings + ~1.1 s simulated latency); set a URL to hit the live FastAPI backend. Set `NEXT_PUBLIC_BACKEND_API_TOKEN` to match the backend's `BACKEND_API_TOKEN` when that is configured. Restart the dev server after editing env (builds inline `NEXT_PUBLIC_*`).
- The fixtures are contract-conformant recordings of the real backend (`frontend/lib/mocks/*` was delivered by the backend teammate) — keep them in sync with `backend/docs/api-contract.md`, not by hand-editing field shapes.
- In mock mode `/case/[id]` auto-runs the first suggested question on load (the recorded trace replays as a live timeline), so a plain page load renders the full flow. Mock `executeAction` remembers freezes per case, so "Is there any way around this freeze?" replays the post-freeze recording.
- `frontend/lib/mocks/index.ts` picks fixtures per case (`case-001`–`case-004`) and applies post-freeze status overrides; `lib/api.ts` is the only place that knows mock vs live.

## Frontend conventions

- **Use design tokens, never raw palette classes or hex in components**: `bg-canvas|surface|raised|inset`, `text-ink|muted|faint`, `border-line|line-strong`, `text-accent`, `ok|danger|info` (+ `-soft`/`-line`), `bg-graph-*`. Tokens live in `app/globals.css` (`:root` + `:root.dark`, mapped via `@theme inline`); every UI change must be correct in **both themes**.
- Component classes from `app/globals.css`: `.card`, `.chip`, `.badge` (+ `-ok/-warn/-danger/-info/-neutral`), `.btn`, `.btn-primary`, `.btn-icon`, `.input`, `.skeleton`, `.eyebrow`, `.mono-tag`. Pages and the header share `.app-container` (max 1200px, stepped padding) — use it for any new page instead of new widths.
- Dark mode is class-based via `@custom-variant dark` toggled by `ThemeProvider` — never add media-based `dark:` styling.
- Graph color/shape/highlight semantics are specified in `plan.md` §7.2 (rose = ring, amber = trail, slate = frozen) — match them. Cytoscape can't consume CSS variables: `GraphCanvas` resolves the `--graph-*` tokens at runtime and rebuilds styles on theme change — add new graph colors as tokens in both theme blocks, not literals in the component.
- `CaseView.tsx` owns all investigation state; child components (`GraphCanvas`, `FindingsPanel`, `EvidenceDetail`, `ActionCard`, `AgentTrace`) are presentational — keep their props/behavior stable when restyling.
- 3D network: `lib/graph3d.ts` is the pure, deterministic layout/role model (columns = hop order, devices/IPs on a lower floor, one link per account pair); `components/Graph3D.tsx` renders it; `components/NetworkPanel.tsx` owns the 3D/2D switch, route strip and legend. Positions are fixed (no physics). Portrait containers rotate the scene (money top → bottom). Touch devices get a "Tap to explore" lock so the page still scrolls. three.js can't read CSS variables either — graph colours come from the same `--graph-*` tokens at runtime.
- Case page story (Oct 16): `LiveTimeline` (components/AgentRun.tsx) streams each tool step while the agent works (`investigateStream` in lib/api.ts: SSE from `/api/investigate/stream` live, paced replay of the recorded trace in mock mode) → `VerdictHero` (headline numbers from evidence, account chips that light the graph, evidence markers on measured amounts, "Route cut" banner after a freeze) → the 3D graph *assembles* step by step (`revealFrames` in lib/agentRun.ts) → `ProofStrip` (every step + its FalkorDB algorithm; click to light its evidence; replay). Emphasis priority lives in CaseView: clicked evidence > clicked step > clicked account > finding > hovered finding > hovered account; only clicks fly the camera (`Emphasis.fly`). `/case/[id]?run=1` auto-runs in live mode too (landing CTA). Presentation logic is pure in `lib/agentRun.ts`; respect `prefers-reduced-motion` in any new animation.
- Cytoscape v3.34 gotcha: it injects `.__________cytoscape_container { position: relative; }`, which defeats `absolute inset-0` on its container — size the graph container explicitly (see `components/GraphCanvas.tsx`).
- `@types/cytoscape`: annotate style arrays as `StylesheetJson`; some runtime-valid numeric style props (e.g. `text-background-padding`) are mistyped as string-only — avoid them.

## Verifying UI changes

- `curl` proves nothing — the app is client-rendered and the graph is a canvas. Use a headless screenshot pass: `puppeteer-core` (install into a temp dir, never the repo) driving Chrome at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Run it against a fresh production build on a spare port (`npm run build && npm run start -- -p 3100`) — the dev server on :3000 may be the user's session.
- Screenshot both themes (`prefers-color-scheme` emulation or the header toggle) and check for console errors; in mock mode `/case/case-001` auto-runs so a plain load shows findings + graph + trace.
- `innerText` reflects CSS `text-transform` (`.eyebrow` renders uppercase) — match assertions case-insensitively.

## Git conventions

- Small, scoped commits (one concern each); prefer explicit paths over `git add .` — check `git status` first.
- Keep `.env.example` updated when adding variables; never commit real keys (`.env*` is gitignored except the examples).
- `main` is production: pushes deploy Render (API) and Vercel (frontend) — the judged demo. Keep main demo-ready, and reseed the cloud DB before any rehearsal or demo (`plan.md` §10).
