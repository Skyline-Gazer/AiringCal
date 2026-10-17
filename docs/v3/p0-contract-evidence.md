# P0 contract evidence (#69)

Measured from source on `dev` (post-#68 bootstrap). Companion to [`p0-contract-audit.md`](./p0-contract-audit.md). Status: **partial** — routes, cache literals, and automated fixtures exist; production payload samples and EdgeOne staging limits remain open.

## Frontend network reads (`public/src/bangumi.js`)

| Call site | Method | Path | Purpose |
|---|---|---|---|
| `checkNSFW()` | GET | `/api/config?key=nsfw` | Age gate |
| Collection view `load()` | GET | `/api/collections?type=&page=&limit=24` | Paginated lists (`limit` fixed at 24 in UI) |
| Collection view `activate()` | GET | `/api/health` | Connection / KV snapshot hint before first load |
| Calendar view | GET | `/api/calendar` | Weekly schedule grid |
| Sync view (legacy UI) | POST | `/api/sync/apply` | **Worker returns 410** (`index.ts`); UI still present |
| Sync view (legacy UI) | GET | `/api/sync/compare` | **410**; UI still present |

`API` base resolves to `window.bgmConfig.apiUrl` or `window.location.origin`. v3 must preserve these read paths and JSON shapes unless a documented compatibility break is tested.

## Worker route map (`apps/web-worker/src/index.ts`)

Public reads delegate to `handleReadRequest` with path rewrite (`/api/collections` → `/collections`, etc.). Authenticated **`POST /api/thumb-gen`** is separate and must not remain a serverless transform path in v3.

Deprecated sync routes respond **410** with JSON `code: DEPRECATED` and `Cache-Control: no-store`.

## Cache-Control constants verified in code

From `apps/web-worker/src/read-api.ts` (also exported as literals in `packages/v3-core/src/read-contract.ts`):

- Calendar JSON: `public, max-age=60, s-maxage=600, stale-while-revalidate=300`
- Collections JSON: `public, max-age=30, s-maxage=300, stale-while-revalidate=120`
- Images: `IMAGE_CACHE_CONTROL` / `IMAGE_CDN_CACHE_CONTROL` (see `read-api.ts`)

## Automated contract evidence

| Evidence | Location |
| --- | --- |
| **Index-level public API table** (410 sync, health, collections `limit=24`) | `apps/web-worker/src/public-api-contract.test.ts` |
| Live web-worker Cache-Control headers | `apps/web-worker/src/read-api-cache-contract.test.ts` |
| v2 route + Cache-Control literals | `packages/v3-core/src/read-contract.ts`, `read-contract.test.ts` |
| 48-item snapshot gzip sizing (#69 split-json input) | `packages/v3-core/src/snapshot-payload-metrics.test.ts` |
| Portable port interfaces + in-memory doubles | `packages/v3-core/src/ports.ts`, `ports.test.ts` |
| Existing R2 payload shape contract | `apps/web-worker/src/r2-mode-contract.test.ts` |
| Collections / calendar / health (legacy harness) | `collections.test.ts`, `read-worker.test.ts`, `health.test.ts` |

## Portable builder SQLite (P1 start, #70)

| Evidence | Location |
| --- | --- |
| Schema v1 + idempotent migration | `packages/v3-builder/src/schema.ts`, `migrate.ts` |
| Lease + KV state store | `packages/v3-builder/src/sqlite-state.ts`, `migrate.test.ts` |
| Portable public snapshot projection (from node-jobs) | `packages/v3-core/src/project-public-snapshot.ts` |
| Builder sync job checkpoint | `packages/v3-builder/src/sync-job.ts`, `sync-job.test.ts` |
| Checkpoint → PublicStore publish (CAS fail-closed) | `packages/v3-builder/src/publish-checkpoint.ts`, `publish-checkpoint.test.ts` |

## Snapshot size fixture (#69)

| Artifact | Location |
| --- | --- |
| 48-item synthetic public snapshot JSON | [`fixtures/public-snapshot-48-synthetic.json`](./fixtures/public-snapshot-48-synthetic.json) |
| Generator + CI guard | `packages/v3-core/src/snapshot-fixture-48.ts`, `snapshot-payload-metrics.test.ts` |

## Portable builder entry (#70)

| Evidence | Location |
| --- | --- |
| `AIRINGCAL_BUILDER=portable` sync path | `apps/node-jobs/src/sync/run-portable.ts`, `run-portable.test.ts` |
| Operator env contract | `apps/node-jobs/docs/operator-contract.md` |

## Gaps (explicit unknowns for #72 / staging)

- No committed fixture of **compressed snapshot byte size** from production R2/D1 export.
- EdgeOne Pages / edge functions limits not exercised in CI; matrix rows in audit remain **candidate** until staging runs.
- Sync tab UX vs 410 backend: v3 should remove tab or repoint to operator docs.

Cloudflare / EdgeOne capability matrix rows in `p0-contract-audit.md` remain **verification backlog** until #72 staging tests land.

Issue: https://github.com/Skyline-Gazer/AiringCal/issues/69
