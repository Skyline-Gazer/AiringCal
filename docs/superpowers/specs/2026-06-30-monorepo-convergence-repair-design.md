# Monorepo Convergence Repair Design

> Status: pending review
> Date: 2026-06-30

## Problem

The monorepo multi-worker migration split the old single Worker into four apps and five shared packages, but several user-facing capabilities did not converge cleanly into the new architecture.

Current verification shows that package boundaries, Worker entrypoints, service bindings, native scheduled sync, queue media processing, R2 image writes, typechecking, tests, and Wrangler dry-run checks all work. However, green tests currently miss or even lock in several regressions:

- Media enrichment writes image status and subject meta, but scheduled sync does not read them when generating public snapshots.
- The public cache page has an HTML shell and `/api/cache`, but no client renderer.
- The historical public animation sync feature was removed from served/generated assets and routing, while older source assets still contain the UI.
- CI/CD tests currently assert deploy-time Cloudflare resource provisioning and temporary config rewriting, which conflicts with the target monorepo architecture spec.
- `scripts/build-check.sh` still targets removed `packages/worker`.
- Analytics rendering only emits comments, not real verified install snippets.

This spec defines the repair scope to make the migrated monorepo internally consistent and user-facing behavior complete.

## Goals

1. Make media-worker enrichment visible in public collection and calendar data.
2. Restore or intentionally retire the animation sync surface. This spec chooses restore, because recent historical reports identify it as the current product entry.
3. Make `/cache` a real public cache statistics page that consumes `/api/cache`.
4. Align CI/CD, README, and tests with the intended routine deploy model.
5. Remove obsolete single-Worker scripts and stale source-of-truth ambiguity.
6. Replace analytics placeholder comments with real build-time injection after verification.

## Non-Goals

- Do not bring back the old `packages/worker` package boundary.
- Do not restore `/api/manage/*`, `/manage`, or `/manage/callback`.
- Do not expose bgm.tv tokens, refresh tokens, client secrets, cron secrets, or raw authorization headers.
- Do not reintroduce legacy image fields such as `images.hash` or `images.hash_large`.
- Do not add a public cron trigger URL.
- Do not change Cloudflare resource names unless required by checked-in config alignment.

## Verified Findings

### Enrichment Pipeline Gap

`apps/media-worker` writes:

- `image:status:{subject_id}`
- `image:index:{hash}`
- `subject:meta:{subject_id}`

`apps/sync-worker` currently calls `mergeCollections(collections)` without loading image or subject meta maps. As a result, later sync generations do not naturally improve `images` or `nsfw` in saved snapshots.

`apps/read-worker` hydrates collection images at request time from `image:status:*`, but does not hydrate `nsfw`, and does not hydrate calendar entries.

### Animation Sync Gap

Before `refactor: remove legacy worker packages`, the old Worker had:

- `POST /api/sync/compare`
- `POST /api/sync/apply`
- `GET /api/check/:id`

The current monorepo keeps low-level `BgmClient` methods such as `getMe`, `upsertCollection`, `getSubjectEpisodeCollections`, and `patchSubjectEpisodeCollections`, but no longer has platform abstractions, compare/apply domain logic, frontend BFF routes, or operation log routes.

`packages/widget/assets/public/src/bangumi.js` still contains the animation sync UI and calls `/api/sync/*`, but `packages/widget/src/generated-assets.ts` serves a reduced JS bundle with only collection and calendar views.

### Cache Page Gap

`frontend-worker` serves `/cache` and forwards `/api/cache` to `read-worker`. `read-worker` returns sanitized JSON. The rendered cache page only contains `#bgm-cache-root`; no script loads or renders the data.

### Deploy Model Drift

The target monorepo architecture says routine deploys should not create Cloudflare resources, list KV namespace IDs, rewrite Wrangler configs, upload secrets, or call Cloudflare REST APIs for schedules.

Current workflow still:

- Lists and creates KV namespaces.
- Creates R2 bucket and queues when missing.
- Generates temporary `wrangler.deploy.toml` files.
- Calls Cloudflare REST APIs for cron diagnostics and deploy sync queue triggering.

Current tests assert these behaviors, so the test suite cannot catch this drift.

### Tooling Residue

`scripts/build-check.sh` still runs `cd packages/worker && npx wrangler deploy --dry-run`, but `packages/worker` is no longer a workspace package.

Ignored local `dist/` directories exist after builds. They are not tracked and are not themselves a functional regression.

## Target Architecture

### Data Flow

```text
sync-worker scheduled/queue trigger
  -> fetch bgm collections and calendar
  -> enrich calendar subjects from cached subject detail or /v0/subjects/{subject_id}
  -> read image status and subject meta from KV
  -> build public snapshots with available enrichment
  -> enqueue missing/stale media or subject meta jobs
  -> write snapshot collection keys, calendar key, summary, sync meta

media-worker queue consumer
  -> read cached subject detail or fetch /v0/subjects/{subject_id}
  -> download subject detail common and large images
  -> write R2 originals and image status
  -> write subject meta

frontend-worker
  -> serve public HTML/assets
  -> BFF route to read-worker for read-only data
  -> BFF route to sync-worker for animation sync only if required

read-worker
  -> read sanitized snapshots, images, cache stats
  -> never call bgm.tv upstream
```

### Package Boundaries

- `packages/bgm-api`: bgm.tv HTTP client and verified endpoint methods.
- `packages/domain`: snapshot/enrichment merge logic, animation sync comparison/apply pure types where possible.
- `packages/storage`: KV/R2 adapters and stable key builders.
- `packages/widget`: generated public HTML, JS, CSS, cache page renderer, shared footer, analytics/meta injection.
- `packages/worker-common`: headers, sanitized errors, internal route helpers, operation log helpers if shared.

No source code should import from or reference `packages/worker`.

## Requirements

### R1. Snapshot Enrichment Must Converge

`sync-worker` must load existing `subject:detail:{subject_id}`, `image:status:{subject_id}`, and `subject:meta:{subject_id}` for subjects seen in collections and calendar.

It must pass a `SubjectImageMap` and `SubjectMetaMap` into domain snapshot builders so saved snapshots contain:

- `images.common` and `images.large` from cached statuses when available.
- `nsfw` from subject meta when available.
- `nsfw: false` for missing subject meta.

The next successful scheduled or queue-triggered sync after media jobs complete must produce improved public snapshots without requiring request-time collection hydration.

`read-worker` may keep request-time image hydration as a defensive fallback, but snapshot generation is the primary convergence point.

Subject detail cache entries store the full `/v0/subjects/{subject_id}` response plus `cached_at`. Workers reuse fresh cache entries for seven days, refresh stale entries when possible, and keep stale entries if refresh fails.

### R2. Calendar Must Use Public Snapshot Shape

Calendar data served by `/api/calendar` must not expose raw bgm.tv image URLs as the primary public image contract.

Calendar entries must be transformed to the same public image shape used by collections:

```json
{
  "images": {
    "common": {
      "hash": "sha256",
      "uri": "/image/sha256",
      "r2_key": "images/sha256/original"
    },
    "large": null
  },
  "image_status": {
    "common": "cached",
    "large": "failed"
  },
  "nsfw": false
}
```

Missing image ref stays `null`. Missing subject meta stays `nsfw: false`.

`image_status.common` and `image_status.large` may expose sanitized cache states such as `cached`, `pending_next_cron`, `queued`, `failed`, and `missing_source` so the widget and operators can distinguish "not cached yet" from a real failed image job without exposing raw upstream URLs or error details.

### R3. Media Queue Must Track Missing Meta, Not Only Images

`sync-worker` must enqueue media jobs for:

- Missing or stale image cache.
- Missing or stale subject meta.

If a collection/calendar item has no image source but subject meta is missing, it must still enqueue a subject-meta-only job.

After fetching collections and calendar, `sync-worker` writes calendar subjects to `image:status:{subject_id}` with `queued` or `missing_source` image states unless that size is already `cached`, and sends their media jobs before later snapshot enrichment reads. This makes calendar-only subjects observable to `read-worker` immediately and starts image downloads even if later KV enrichment fails; if queue delivery fails, the trigger still retries. `media-worker` remains responsible for downloading images, writing R2 objects, and replacing `queued` with terminal cache states, and skips any image size that is already `cached`.

The queue message schema must explicitly support optional image work and required subject meta work:

```ts
interface MediaJob {
  subject_id: number
  title: string
  images?: {
    common?: string
    large?: string
  }
  subject_meta?: true
}
```

`media-worker` must preserve previous successful image or subject meta data on temporary failures.

### R4. Cache Page Must Render Real Data

`/cache` must load a cache-page script from `packages/widget` and render `/api/cache`.

The page must show:

- Total subjects.
- Common cached/missing/failed counts.
- Large cached/missing/failed counts.
- Filter tabs for `cached`, `pending_next_cron`, `queued`, `failed`, and `missing_source`.
- Per-row subject ID, title, common status, large status, public image URI, R2 key, and sanitized last error.

The page must not expose token-like strings or raw authorization data. Tests must include a fixture with token-shaped errors and assert they are absent from rendered HTML.

### R5. Animation Sync Must Be Restored In Monorepo Form

Restore the public animation sync feature as a first-class monorepo capability, not as a leftover asset.

Required frontend routes:

- Home widget shows collection, calendar, and animation sync tabs.
- Sync tab calls `POST /api/sync/compare`.
- Sync tab calls `POST /api/sync/apply`.
- Sync operation links point to `GET /api/check/:id`.

Required Worker routes:

- `frontend-worker` exposes public BFF routes under `/api/sync/*` and `/api/check/:id`.
- Sync write execution must run in an internal Worker boundary. Prefer `sync-worker` service binding/RPC-like fetch routes for write operations so frontend-worker stays a BFF.
- The route must not be a public cron trigger and must not share cron secrets.

Required behavior:

- Compare resolves token owner usernames with `getMe(token)`.
- Compare fetches anime collections with `subject_type=2`.
- Apply writes only safe animation sync fields: collection `type` and `rate`.
- Episode progress sync uses episode collection APIs and does not send book-only `ep_status` or `vol_status` fields to collection write endpoints.
- Apply does not send `tags: []` or empty `comment`.
- Operation logs are stored under short-lived KV keys and rendered through `/api/check/:id`.
- Public errors are sanitized.

Before touching bgm.tv API calls for this work, verify every endpoint in `docs/example/api/bgm-api.json` where present. OAuth endpoints that are not present in local OpenAPI must not be expanded in this repair.

### R6. Widget Source Of Truth Must Be Single And Regenerable

`packages/widget/assets/theme/bangumi.{js,css}` or another clearly named source file must be the only editable source for public widget assets.

`packages/widget/src/generated-assets.ts` must be generated from that source by a checked-in script.

Tests must fail if:

- The generated JS omits animation sync when the source includes it.
- The source references `/api/sync/*` but frontend-worker has no matching BFF route.
- `assets/public/src/*`, `assets/theme/*`, and generated assets drift in behavior-critical route names.

If the project intentionally removes animation sync in the future, the source assets, generated assets, README, historical guidance, and tests must all remove it in the same change.

### R7. Deploy Workflow Must Match The Chosen Routine Deploy Model

Routine deploy must be made consistent with the target monorepo architecture.

Preferred target:

- No resource creation in routine deploy.
- No KV namespace listing to discover IDs in routine deploy.
- No temporary rewriting of checked-in Worker configs during routine deploy.
- No secret upload loops.
- No Cloudflare REST schedule mutation.
- Checked-in or environment-specific config supplies stable resource IDs.

If operational needs require a provisioning path, it must be a separate manual workflow or script named as initial provisioning, not part of push deploy. Its required Cloudflare token permissions must be documented separately from routine deploy token permissions.

Tests must assert the absence of routine deploy provisioning behavior rather than require it.

### R8. Obsolete Scripts Must Be Removed Or Repointed

`scripts/build-check.sh` must not reference `packages/worker`.

Either:

- Delete it if unused, or
- Repoint it to the root `pnpm -r --if-present build:check` behavior.

README and package scripts must not mention removed single-Worker paths.

### R9. Analytics Must Be Real Or Explicitly Unsupported

Build-time analytics injection must not emit placeholder comments as if the feature works.

For each configured analytics provider:

- Verify the current official install snippet before implementing.
- Render the actual snippet only when its env var is present.
- Omit the snippet entirely when absent.
- Tests must assert provider-specific output and absence of unrelated providers.

If official snippet verification is deferred, README must mark analytics as not implemented yet and code must not pretend to inject it.

Webmaster verification meta tags are already structurally implemented and remain in scope for regression tests.

## Testing Requirements

### Domain

- Builds collection snapshots with image and subject meta maps.
- Builds calendar snapshots with image and subject meta maps.
- Uses subject detail as the canonical source for calendar display fields, including `total_episodes`.
- Reuses fresh subject detail cache without calling `/v0/subjects/{subject_id}`.
- Missing meta writes `nsfw: false`.
- Restricted/not-found meta writes `nsfw: true`.
- No legacy image fields appear.

### Sync Worker

- Reads existing image status and subject meta before writing snapshots.
- Reuses `subject:detail:{subject_id}` before fetching subject detail.
- Enqueues image jobs for missing/stale image status.
- Enqueues subject-meta-only jobs when images are absent but meta is missing.
- Queue-triggered sync and scheduled sync share the same convergence logic.
- No public `/__cron/sync`.

### Media Worker

- Handles image+meta jobs.
- Handles meta-only jobs.
- Uses `/v0/subjects/{subject_id}` as the canonical image source for both collection and calendar jobs.
- Reuses `subject:detail:{subject_id}` before fetching subject detail.
- Tracks the downloaded source URL internally so older calendar-derived cached images refresh to subject-detail quality.
- Keeps prior successful image/meta data on temporary failures.
- 404 subject detail writes conservative NSFW meta.

### Read Worker

- `/collections` returns enriched snapshot data.
- `/calendar` returns enriched public image shape and NSFW booleans.
- `/cache` returns sanitized status data only.
- `/image/:hash` validates hash and reads `images/{hash}/original`.

### Frontend Worker

- Public BFF routes forward read paths to read-worker.
- Sync BFF routes forward write/compare paths to the chosen internal Worker.
- `/cache` serves an HTML page that loads its renderer.
- `/api/check/:id` returns sanitized operation logs.

### Widget

- Home page renders collection, calendar, and animation sync views.
- Cache page renders fixture data from `/api/cache`.
- Generated assets match source assets for route names and feature tabs.
- Footer remains shared across public pages.
- Analytics snippets are real and conditional, or absent when unsupported.

### CI / Docs

- Tests fail if routine deploy creates resources or rewrites configs.
- README describes the final routine deploy path.
- README documents any separate initial provisioning path.
- README does not mention removed `packages/worker` source paths or legacy cron URLs.

## Verification Commands

Run after implementation:

```bash
pnpm -r typecheck
pnpm -r test
node --test scripts/*.test.mjs
WRANGLER_LOG_PATH=/private/tmp/bangumitv-wrangler-build-check.log pnpm -r --if-present build:check
rg -n "packages/worker|/__cron/sync|images\\.hash|hash_large|wrangler kv namespace create|wrangler r2 bucket create|wrangler secret put" README.md .github scripts apps packages
```

The final `rg` command may return historical docs under `docs/superpowers/`; it must not return active README, workflow, script, app, or package source hits unless explicitly justified.

## Rollout Order

1. Fix tests that currently lock in wrong deploy and asset assumptions.
2. Add domain snapshot enrichment helpers for collections and calendar.
3. Update sync-worker to load enrichment maps and enqueue meta/image jobs.
4. Update read-worker calendar and defensive hydration behavior.
5. Restore animation sync platform/domain logic and BFF/internal Worker routes.
6. Regenerate widget assets from a single source and add drift tests.
7. Implement cache page renderer.
8. Align deploy workflow and README with routine deploy versus initial provisioning.
9. Remove or repoint obsolete scripts.
10. Implement or explicitly defer real analytics snippets.
11. Run full verification and update docs in the same atomic changes.

## Acceptance Criteria

- Public collections and calendar show cached image refs and NSFW booleans after a successful media job plus the next sync.
- `/cache` is visibly populated from `/api/cache`.
- Animation sync is reachable from the home widget and its compare/apply/check flows work against mocked bgm clients in tests.
- No active source path references removed `packages/worker`.
- Routine deploy workflow no longer provisions long-lived Cloudflare resources.
- Existing tests pass and new regression tests fail on the currently observed gaps.
- README matches the implemented architecture and contains no speculative functionality.

## Open Decisions

None for this repair spec. The chosen path is to restore animation sync because current historical reports describe it as the product entry, and because the source assets still include it. If product direction changes, replacing R5 with explicit removal is a separate decision and must update assets, routes, docs, and tests together.

## Self-Review

- No TBD/TODO placeholders.
- No implementation code is prescribed beyond interfaces and acceptance behavior.
- bgm.tv API endpoints that require verification are called out explicitly.
- The spec separates routine deploy from initial provisioning.
- The spec treats generated/local dist output as non-source and excludes it from the repair scope.
