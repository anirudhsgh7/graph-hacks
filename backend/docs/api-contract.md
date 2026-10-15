# API contract v1

Base URL: `http://localhost:8000` in development, the Render URL when deployed (`NEXT_PUBLIC_API_BASE_URL`).
JSON in, JSON out. Every response field below exists in a real response under `frontend/lib/mocks/`,
and `backend/openapi.json` is the machine-readable version for generating `lib/types.ts`.

**Change rule:** adding optional fields is fine. Renaming or removing a field needs both of us to
agree, plus a line in the changelog at the bottom.

---

## POST /api/investigate

Request:

```json
{ "question": "Who is behind the burst of transfers from account A17?", "case_id": "case-001" }
```

`case_id` is optional. Without it, the question must name an account (e.g. "Is M8 laundering money?").
Measured latency in rule-based mode is about 1 s. With the LLM, add several model round-trips (provider-dependent; not measured here).

Response (`InvestigateResponse`; see `investigate-case-001-burst.json`):

| Field | Meaning |
|---|---|
| `investigation_id`, `case_id`, `question`, `created_at` | identity |
| `status` | `complete` / `no_evidence` / `partial` - drives the result card |
| `conclusion` | `suspicious` / `no_evidence` / `inconclusive` - computed by rule, not by the model |
| `summary` | 1-4 sentences for the top of the panel |
| `findings[]` | `{id, title, detail, confidence, evidence_refs[]}`; every ref exists in `evidence[]` |
| `evidence[]` | `{id, type, tool, node_ids[], edge_ids[], result_excerpt{}, receipts[{query, params, cypher}]}` |
| `proposed_actions[]` | `{id, type, label, account_ids[], requires_confirmation, evidence_refs[], simulation}` |
| `trace[]` | `{step, tool, args, ok, rows, duration_ms, headline, evidence_ids[], error?}` - the agent timeline |
| `graph` | `{nodes[], edges[], highlight{}}` - bounded subgraph, at most 150 nodes |
| `meta` | `{mode: llm\|rule_based, model, narrative_source: llm\|deterministic, tool_iterations, latency_ms, maxflow_engine, frozen_accounts[], notes[]}` |

**Evidence `type` values** and what the UI can do with them:

| type | node_ids | edge_ids | Highlight as |
|---|---|---|---|
| `community` | members first, then devices and IPs | internal transfers | ring outline (`result_excerpt.verdict`: `mule_ring` / `shared_infrastructure_only` / `no_ring`) |
| `path` | route in order | transfers in time order | path (`result_excerpt.quality`: `strong` / `weak` / `structural`) |
| `no_path` | src, dst | - | "no route" badge |
| `capacity` | accounts carrying money | - | `result_excerpt.flow_pairs` as flow arrows |
| `freeze_plan` | recommended accounts first | - | scissors / cut markers |
| `simulation` | frozen + residual route nodes | - | before/after numbers |
| `shared_entities` | account, linked accounts, devices, IPs | - | pivot |
| `pattern` | accounts in pass-through chains | transfer pairs | layering |
| `profile`, `ranking` | the account(s) | - | info |

**`graph`**

- `nodes[]`: `{id, label: Account|Device|IPAddress, type?, kind?, status?, anomaly_score?, x_hint?, y_hint?}`. `x_hint`/`y_hint` (0-1) are set only for nodes on the main path, to lay it out left to right.
- `edges[]`: `{id, source, target, type: TRANSFER|USED_DEVICE|USED_IP, amount?, ts?, channel?}`.
- `highlight`: `{paths[][], communities[][], infrastructure_clusters[][], freeze_plan[], flows[][], frozen[]}`.

**Action `type` values:** `freeze_accounts` (with `simulation: {capacity_before, capacity_after, residual_routes[][], remaining_paths, verified_on}`), `flag_accounts`, `clear_alert`, `export_case_report`.

Render numbers from structured fields (`result_excerpt`, `simulation`), never by parsing prose.

## POST /api/investigate/stream

Same request. The response is `text/event-stream`:

```
event: step     data: {"step":1,"tool":"account_profile","args":{...},"status":"started"}
event: step     data: {"step":1,...,"status":"done","ok":true,"rows":1,"duration_ms":45,"headline":"anomaly rank #7 of 595","evidence_ids":["ev-1"]}
event: finding  data: {"id":"f-1","title":"Mule ring detected (7 accounts)"}
event: done     data: { ...the full InvestigateResponse... }
event: error    data: {"code":"...","message":"...","detail":{}}     (instead of done)
```

Comment lines (`: keep-alive`) arrive every 15 s while waiting.

## POST /api/actions/execute

Header `Authorization: Bearer <BACKEND_API_TOKEN>` (only when the backend has a token set).

```json
{ "action_id": "act-0bf92302", "confirm": true, "case_id": "case-001" }
```

Response: `{action_id, type, status: "executed", affected[], graph_delta: {nodes: [{id, status}], case}, audit_id, report_url?}`.
Executing the same action twice returns 409 `ACTION_CONFLICT`. After a freeze, call
`GET /api/graph/snapshot` to refresh the canvas.

## GET /api/graph/snapshot?case_id=

`Graph` (same shape as `investigate.graph`): the latest investigation's subgraph with **current**
account statuses, or the seed account's largest transfers if the case has not been investigated yet.

## GET /api/cases and GET /api/cases/{case_id}

List: `[{id, title, alert, status, seed_accounts[], created_at, suggested_questions[]}]`.
Detail adds `investigations[]` (newest first), `audit_trail[]` (newest first) and `latest_investigation`
(full `InvestigateResponse` or `null`), which supports "replay last investigation" when the LLM is down.

## GET /api/cases/{case_id}/report?format=json|markdown

An evidence-linked report assembled from stored data. Use markdown for a printable view.

## POST /api/evidence/replay

```json
{ "query": "shared_infrastructure", "params": {"id": "A17"}, "expected_fingerprint": "6e75ce7e7f18933d" }
```

Response: `{query, cypher, params, row_count, rows[] (first 50), fingerprint, matches_expected}`.
Only the read-only product queries can be replayed.

## GET /api/queries, GET /api/health, POST /api/admin/reseed

- `queries`: `[{name, file, description, cypher}]`.
- `health`: `{status: ok|degraded, db: ok|unreachable, llm: configured|not_configured, llm_model, graph: {accounts, transfers}, capabilities, version}`.
- `reseed`: token required, and disabled when no token is configured.

## Errors (every endpoint)

```json
{ "error": { "code": "ACTION_CONFLICT", "message": "human readable", "detail": {} } }
```

| Code | HTTP | UI treatment |
|---|---|---|
| `BAD_REQUEST` | 400 | inline message (e.g. "name an account or open a case") |
| `UNAUTHORIZED` | 401 | token missing on actions |
| `NOT_FOUND` | 404 | unknown case |
| `ACTION_CONFLICT` | 409 | inline on the action card, then refresh the snapshot |
| `RATE_LIMITED` | 429 | "try again in a minute" |
| `DB_UNAVAILABLE` | 503 | red banner; free hosting may be waking up |
| `INTERNAL` | 500 | generic banner and retry |

An LLM outage is **not** an error: the investigation completes in rule-based mode, and
`meta.notes` explains why (`LLM_UNAVAILABLE: ...` or `LLM_RATE_LIMITED: ...`).

## Changelog

- v1 (Oct 15): initial contract.
