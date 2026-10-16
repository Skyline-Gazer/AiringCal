# P0 contract evidence (#69)

Measured from source on `feat/v3.0.0` (baseline `dev@a4b3b082`). Companion to [`p0-contract-audit.md`](./p0-contract-audit.md). Status: **partial** — routes and frontend reads verified in repo; production payload sizes and EdgeOne staging limits are still open.

## Frontend network reads (`public/src/bangumi.js`)

| Call site | Method | Path | Purpose |
|---|---|---|---|
| `checkNSFW()` | GET | `/api/config?key=nsfw` | Age gate |
| Collection view `load()` | GET | `/api/collections?type=&page=&limit=24` | Paginated lists (`limit` fixed at 24 in UI) |
| Collection view `activate()` | GET | `/api/health` | Connection / KV snapshot hint before first load |
| Calendar view | GET | `/api/calendar` | Weekly schedule grid |
| Sync view (legacy UI) | POST | `/api/sync/apply` | **Worker returns 410** (`index.ts`); UI still present |
| Sync view (legacy UI) | GET | `/api/sync/compare` | **410**; UI still present |

`API` base resolves to `window.bgmConfig.apiUrl` or `window.location.origin` (lines 2–3). v3 must preserve these read paths and JSON shapes unless a documented compatibility break is tested.

## Worker route map (`apps/web-worker/src/index.ts`)

Public reads delegate to `handleReadRequest` with path rewrite (`/api/collections` → `/collections`, etc.). Authenticated **`POST /api/thumb-gen`** is separate (`handleThumbGenRequest`) and must not remain a serverless transform path in v3.

Deprecated sync routes respond **410** with JSON `code: DEPRECATED` and `Cache-Control: no-store`.

## Cache-Control constants verified in code

From `apps/web-worker/src/read-api.ts`:

- Calendar JSON: `public, max-age=60, s-maxage=600, stale-while-revalidate=300`
- Collections JSON: `public, max-age=30, s-maxage=300, stale-while-revalidate=120`
- Images: `IMAGE_CACHE_CONTROL` / `IMAGE_CDN_CACHE_CONTROL` (see same file)

Automated assertions exist in `apps/web-worker/src/collections.test.ts` and `read-worker.test.ts` (e.g. collections `s-maxage=600` calendar path).

## Contract tests already in tree (reuse for v3 matrix)

| Area | Test file |
|---|---|
| Collections / calendar read | `apps/web-worker/src/collections.test.ts`, `read-worker.test.ts` |
| Health / R2 mode | `apps/web-worker/src/health.test.ts`, `health-r2-api.test.ts` |
| R2 snapshot pointer | `apps/web-worker/src/r2-snapshot.test.ts`, `r2-mode-contract.test.ts` |
| Thumb gen (retire in v3) | `apps/web-worker/src/thumb-gen.test.ts` |
| Version endpoint | `apps/web-worker/src/version.test.ts` |
| Public manifest / digest | `packages/domain` (see audit table) |

## Gaps (explicit unknowns for #72 / staging)

- No committed fixture of **compressed snapshot byte size** from production R2/D1 export on this branch.
- EdgeOne Pages / edge functions limits not exercised in CI; matrix rows in audit remain **candidate** until staging runs.
- Sync tab UX vs 410 backend: behavior is “errors in UI” today; v3 should either remove tab or repoint to operator docs — product choice, not inferred here.

## Next P0 engineering slice

1. Add a single contract test module that tables `GET` read routes → expected status, minimal JSON keys, and `Cache-Control` regex (extend existing tests, do not duplicate harness).
2. Capture one anonymized snapshot size sample into `docs/v3/fixtures/` when owner provides export (not fabricated).
3. Define portable adapter interfaces on a **`dev`-based branch** per handoff (#70), after (1).

Issue: https://github.com/Skyline-Gazer/AiringCal/issues/69
