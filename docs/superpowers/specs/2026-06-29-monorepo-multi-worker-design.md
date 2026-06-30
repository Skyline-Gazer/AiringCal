# Monorepo Multi-Worker Architecture Design

> Status: pending review
> Date: 2026-06-29

## Goals

Rebuild the project as a monorepo with multiple Cloudflare Worker deployment units. The new architecture should reduce the chance of hitting the Workers Free plan per-invocation subrequest limit by moving heavy work into separate Worker invocations and queue consumers.

This is a new architecture. It does not preserve legacy response fields or legacy package structure for compatibility.

The design must also include:

- Reliable NSFW enrichment from full bgm.tv subject detail responses.
- R2 image caching for both `images.common` and `images.large`.
- A public cache statistics page.
- Footer links for cache statistics and the current GitHub commit.
- Build-time analytics and webmaster verification injection.

## Non-Goals

- Do not expose bgm.tv API tokens, refresh tokens, client secrets, or cron secrets in public pages or public API responses.
- Do not preserve old `images.hash` or `images.hash_large` fields.
- Do not keep the old single `packages/worker` package boundary as the target architecture.
- Do not make every capability its own Worker. The architecture should stay small enough to operate comfortably.

## Verified Inputs

The NSFW design is based on `docs/tmp/nsfw-solution.md` and local OpenAPI verification in `docs/example/api/bgm-api.json`:

- `GET /v0/subjects/{subject_id}` returns full `Subject`.
- `Subject.nsfw` exists and is boolean.
- `SlimSubject` does not include `nsfw`.
- `Legacy_SubjectSmall` does not include `nsfw`.
- `GET /v0/subjects/{subject_id}` uses `OptionalHTTPBearer`.
- `OptionalHTTPBearer` says NSFW content is only visible to authorized users and non-authorized users get `404`.

Cloudflare configuration fields were checked against the local Wrangler schema:

- Service bindings use `services`.
- Queue producers and consumers use `queues.producers` and `queues.consumers`.
- Cron triggers use `triggers.crons`.
- KV and R2 bindings use `kv_namespaces` and `r2_buckets`.

## Target Monorepo Layout

```text
apps/
  frontend-worker/
  read-worker/
  sync-worker/
  media-worker/

packages/
  bgm-api/
  domain/
  storage/
  widget/
  worker-common/
```

### `apps/frontend-worker`

The only public Worker entrypoint.

Responsibilities:

- Serve the main page.
- Serve the cache statistics page at `/cache`.
- Serve widget assets.
- Serve `/image/:hash` publicly by delegating to the internal read/image path.
- Forward data requests to `read-worker` through a service binding.
- Render footer links:
  - Cache statistics: `/cache`
  - Build commit: `https://github.com/<owner>/<repo>/commit/<sha>`

The browser never calls internal Workers directly. Internal Workers remain reachable through bindings, not public routes.

### `apps/read-worker`

Internal service-bound Worker for read paths.

Responsibilities:

- Read collection snapshots from KV.
- Read calendar snapshots from KV.
- Read config such as `NSFW_SHOW`.
- Read health status.
- Read image objects from R2 by hash.
- Expose cache statistics data for `/cache`.

It should not perform bgm.tv upstream requests, token refresh, cron sync, or media downloads.

### `apps/sync-worker`

Native cron sync Worker.

Responsibilities:

- Own the single cron trigger through the Worker `scheduled()` handler.
- Declare the cron schedule in Worker config with `triggers.crons`.
- Refresh or validate bgm.tv tokens.
- Fetch user collections.
- Fetch calendar data.
- Read existing subject meta and image cache status from KV.
- Generate new snapshots using `packages/domain`.
- Enqueue media jobs for missing or stale image cache and missing or stale subject meta.
- Write sync generation metadata.

There is no public `POST /__cron/sync` route in the new architecture. Production sync is triggered by Cloudflare scheduled events, not by `curl`ing a Worker URI. If a manual production run is needed, it should use Cloudflare's scheduled-event tooling or an explicitly internal/admin mechanism added later, not a public cron URL and `CRON_SECRET`.

This Worker should keep heavy media and subject-detail enrichment out of the main cron invocation.

### `apps/media-worker`

Queue consumer Worker for media and metadata enrichment.

Responsibilities:

- Consume media jobs from Cloudflare Queues.
- Download `images.common` and `images.large`.
- Store downloaded image bytes in R2.
- Compute SHA-256 lowercase hex hashes from downloaded image bytes.
- Write per-subject image cache status to KV.
- Fetch full subject detail with an authorized `BgmClient`.
- Write subject meta cache to KV, including `nsfw`.

Images and NSFW enrichment are intentionally in one Worker because both are supplemental, retryable, and safe to process gradually after cron discovers work.

## Packages

### `packages/bgm-api`

Contains bgm.tv client code and bgm.tv types.

Responsibilities:

- `BgmClient`.
- HTTP error classification.
- Token status and refresh helpers.
- Collection, calendar, subject detail, and image download APIs.
- Tests that pin endpoint method, auth, and response handling against `docs/example/api/bgm-api.json` where covered.

### `packages/domain`

Pure domain logic.

Responsibilities:

- Snapshot schema.
- Collection merge.
- Calendar transform.
- Subject meta schema.
- Image cache status schema.
- Queue message schema.
- Cache statistics aggregation model.
- NSFW finalization rules.

This package should not import Worker runtime bindings.

### `packages/storage`

Storage adapters and key naming.

Responsibilities:

- KV adapter.
- R2 image store.
- Stable KV key builders.
- Stable R2 key builders.

Important keys:

```text
snapshot:collections:{type}
snapshot:calendar
snapshot:summary
sync:meta
subject:meta:{subject_id}
image:status:{subject_id}
image:index:{hash}
```

Important R2 key:

```text
images/{hash}/original
```

### `packages/widget`

Frontend assets and static HTML generation.

Responsibilities:

- Main widget JS and CSS.
- Cache statistics page JS and CSS reuse.
- HTML templates.
- Shared HTML shell and layout primitives.
- A single reusable footer component/template partial used by every public page.
- Build-time rendering of analytics scripts.
- Build-time rendering of webmaster verification meta tags.
- Build-time rendering of footer links and commit information.

Top-level frontend/theme assets have been consolidated into this package:

- `public/index.html`
- `public/src/bangumi.js`
- `public/src/bangumi.css`
- theme CSS, widget JS, and theme page templates previously stored outside `packages/widget`

After migration, there is no standalone theme asset directory and no separate directory for one-off styles. Theme CSS, widget JS, page templates, and cache-page assets live under `packages/widget` with one source of truth.

### `packages/worker-common`

Shared Worker helpers.

Responsibilities:

- CORS and cache headers.
- Public error response shape.
- Structured log helpers.
- Secret-safe error sanitization.
- Internal request helpers.
- Timing-safe secret comparison where manual endpoints require a secret.

## Data Flow

### Public Read Flow

```text
Browser
  -> frontend-worker
  -> read-worker service binding
  -> KV/R2
  -> frontend-worker response
```

The public surface remains small:

```text
/
/cache
/src/bangumi.js
/src/bangumi.css
/image/:hash
```

Public JSON endpoints may remain under the frontend Worker as BFF routes, but their implementation should call `read-worker` through a binding.

### Sync Flow

```text
sync-worker cron/manual trigger
  -> validate/refresh token
  -> fetch collections
  -> fetch calendar
  -> read current subject meta and image status
  -> build snapshot with available data
  -> enqueue media jobs for missing/stale work
  -> write snapshot and sync metadata
```

The first sync may produce a snapshot before every image and NSFW meta entry is complete. Later media jobs and later sync generations improve the snapshot.

### Media Queue Flow

```text
sync-worker
  -> MEDIA_QUEUE.send(...)
  -> media-worker queue consumer
  -> bgm.tv image fetch / subject detail fetch
  -> R2 + KV status writes
```

Queue is preferred over direct service-binding calls for heavy work because it naturally batches, retries, and gives each consumer invocation its own subrequest budget.

## Image Cache Design

The project stores both common and large images. Frontend cards use `images.common`. `images.large` is still downloaded and stored for reuse by this project or other projects.

### Hash Rule

The image hash is:

```text
sha256(downloaded_image_bytes).hex_lowercase
```

The hash is computed from the downloaded image bytes, not from the source URL.

### R2 Key Rule

Every stored image uses:

```text
images/{hash}/original
```

The R2 object should store:

- HTTP content type.
- Byte length.
- Source URL.
- Subject ID.
- Source size: `common` or `large`.
- Cached timestamp.

### Snapshot Image Shape

New snapshots use only the new image shape:

```json
{
  "images": {
    "common": {
      "hash": "sha256-common",
      "uri": "/image/sha256-common",
      "r2_key": "images/sha256-common/original"
    },
    "large": {
      "hash": "sha256-large",
      "uri": "/image/sha256-large",
      "r2_key": "images/sha256-large/original"
    }
  }
}
```

If a size is not cached yet, that size is `null`:

```json
{
  "images": {
    "common": null,
    "large": null
  }
}
```

There are no legacy `images.hash` or `images.hash_large` fields.

### Public and Internal Image Access

README must document these reusable contracts:

```text
Public URI:
https://<frontend-domain>/image/<hash>

Internal R2 key:
images/<hash>/original

Hash:
sha256(downloaded_image_bytes).hex_lowercase
```

Other projects can either call the public URI or bind to the same R2 bucket and read the R2 key directly.

## NSFW Enrichment Design

The frontend does not infer NSFW. It only consumes `nsfw: boolean`.

### Subject Meta Cache

KV key:

```text
subject:meta:{subject_id}
```

Value:

```json
{
  "subject_id": 23080,
  "exists": true,
  "nsfw": true,
  "checked_at": 1782650000,
  "reason": "subject_detail"
}
```

Allowed values:

- `exists: true`: full subject detail returned `200`.
- `exists: false`: full subject detail returned `404`.
- `exists: null`: temporary failure such as network error, timeout, or 5xx.

Reason values:

- `subject_detail`
- `not_found_or_restricted`
- `network_error`
- `upstream_error`

### 404 Policy

If authorized `GET /v0/subjects/{subject_id}` returns `404`, cache:

```json
{
  "exists": false,
  "nsfw": true,
  "reason": "not_found_or_restricted"
}
```

This intentionally favors over-masking. Public pages should not expose an item that might be restricted NSFW content.

### Snapshot Rule

Collection and calendar snapshot entries write:

```text
nsfw = subjectMetaMap.get(subjectId)?.nsfw ?? false
```

Because the new architecture does not preserve legacy behavior, incomplete subject meta means `false` until enrichment succeeds or returns restricted/not-found. The next successful sync generation writes the updated value.

## Cache Statistics Page

`/cache` is public and requires no authentication.

The page must not expose:

- bgm.tv access tokens.
- refresh tokens.
- client secrets.
- cron secret.
- raw upstream authorization headers.

Everything else about cache state is public, including hash, public URI, R2 key, subject ID, title, and sanitized error summaries.

### Cache Status KV

KV key:

```text
image:status:{subject_id}
```

Value:

```json
{
  "subject_id": 123,
  "title": "Example",
  "common": {
    "status": "cached",
    "hash": "sha256-common",
    "uri": "/image/sha256-common",
    "r2_key": "images/sha256-common/original",
    "queued_at": 1782650000,
    "cached_at": 1782650300,
    "last_error": null
  },
  "large": {
    "status": "pending_next_cron",
    "hash": null,
    "uri": null,
    "r2_key": null,
    "queued_at": 1782650000,
    "cached_at": null,
    "last_error": null
  },
  "last_cron_generation": 42,
  "last_media_job_id": "media-job-id"
}
```

Status values:

- `cached`: stored in R2 successfully.
- `pending_next_cron`: discovered but not queued in the current cron generation.
- `queued`: sent to the media queue.
- `failed`: media worker attempted and failed.
- `missing_source`: bgm.tv data did not include that image size URL.

### Cache Page UI

The cache page reuses the current frontend visual language and CSS.

It should show:

- Total subjects discovered.
- Common cached count.
- Common missing or failed count.
- Large cached count.
- Large missing or failed count.
- Last sync generation.
- Last media job timestamp.
- Filter tabs for `cached`, `pending_next_cron`, `queued`, `failed`, and `missing_source`.
- Per-row subject ID, title, common status, large status, public image URIs, R2 keys, and sanitized last error.

The footer links to this page from every public HTML page.

## Footer and Build Version

Footer is a shared widget component/template partial, not copied per page. Every public HTML page uses the same footer renderer so links, build metadata, and future footer changes stay consistent.

Every public page footer includes:

```text
Cache statistics -> /cache
Build <short-sha> -> https://github.com/<owner>/<repo>/commit/<full-sha>
```

Build-time environment:

```text
BANGUMI_GIT_COMMIT_SHA
BANGUMI_GIT_REPOSITORY_URL
```

GitHub Actions may map:

```text
GITHUB_SHA -> BANGUMI_GIT_COMMIT_SHA
GITHUB_REPOSITORY -> https://github.com/{GITHUB_REPOSITORY}
```

If commit data is unavailable, footer shows `Build unknown` without a commit link.

Footer tests must render every public page template and assert that they all use the shared footer output, rather than each page carrying a local footer variant.

## Build-Time Analytics and Webmaster Injection

Analytics scripts and webmaster verification meta tags are generated during the widget/frontend build. They are not guessed at runtime and not inserted on every request.

### Analytics Env

```text
BANGUMI_GA4_ID
BANGUMI_CLARITY_ID
BANGUMI_YANDEX_METRICA_ID
BANGUMI_BAIDU_TONGJI_ID
```

If a value is present, the build renders that platform's snippet. If absent, no snippet for that platform appears in the HTML.

Before implementation, each snippet must be verified against official platform documentation or current platform-provided install code. Do not write snippet details from memory.

### Webmaster Verification Env

```text
BANGUMI_GOOGLE_SITE_VERIFICATION
BANGUMI_YANDEX_VERIFICATION
BANGUMI_BING_SITE_VERIFICATION
BANGUMI_BAIDU_SITE_VERIFICATION
```

Generated meta names:

```html
<meta name="google-site-verification" content="...">
<meta name="yandex-verification" content="...">
<meta name="msvalidate.01" content="...">
<meta name="baidu-site-verification" content="...">
```

If a value is absent, the corresponding meta tag is omitted.

### Build Tests

`packages/widget` must test:

- Empty env renders no analytics snippets.
- Empty env renders no webmaster meta tags.
- Each analytics env renders only its own snippet.
- Each verification env renders only its own meta tag.
- Footer commit link renders with a valid SHA.
- Footer falls back cleanly when SHA is missing.

## Cloudflare Binding Plan

### `frontend-worker`

Bindings:

```text
READ_WORKER service binding -> read-worker
```

Optional direct R2 binding is avoided unless `/image/:hash` performance requires it. The default design keeps image reads behind `read-worker`.

### `read-worker`

Bindings:

```text
AIRING_CAL_KV KV
AIRING_CAL_R2 R2
```

### `sync-worker`

Bindings:

```text
AIRING_CAL_KV KV
MEDIA_QUEUE queue producer
```

Secrets and vars:

```text
BANGUMI_TOKEN
BANGUMI_USERS
SYNC_MODE
```

Cron config:

```text
triggers.crons = ["0 */4 * * *"]
```

The exact syntax must be written in the target Worker config only after validating against the local Wrangler schema and `wrangler --help` / config docs for the chosen config format.

### `media-worker`

Bindings:

```text
AIRING_CAL_KV KV
AIRING_CAL_R2 R2
MEDIA_QUEUE queue consumer
```

`media-worker` does not require bgm.tv credentials. It downloads image URLs supplied by `sync-worker` and calls optional subject-detail endpoints with `OptionalHTTPBearer` omitted.

## CI/CD and Cron Deployment

The current workflow performs too many deployment-time infrastructure mutations: creating KV/R2 resources, listing KV namespaces, rewriting Wrangler config files, uploading secrets on every run, calling Cloudflare REST APIs with `curl` to inspect or create cron schedules, and deploying multiple Workers through ad hoc commands. The monorepo architecture replaces this with a smaller and more predictable pipeline.

### CI/CD Goals

- CI validates source and config.
- CD deploys Workers from checked-in config.
- CI/CD does not provision long-lived Cloudflare resources on every deploy.
- CI/CD does not rewrite committed Worker config files during deploy.
- CI/CD does not upload secrets on every deploy.
- CI/CD does not call Cloudflare REST APIs with `curl` to create cron schedules.
- The deploy token should need only the permissions required to deploy Workers and read referenced resources, not broad resource-management permissions for every run.

### Resource Provisioning Model

Cloudflare resources are provisioned once outside normal deploy runs:

```text
KV namespace title: airing-cal-kv
KV namespace id: copied into each Worker config as kv_namespaces.id
R2 bucket: airing-cal-images
Queue: airing-cal-media
Service bindings
Worker secrets
Cron schedule in sync-worker config
```

After initial provisioning, GitHub Actions deploys against stable resource identifiers checked into environment-specific Wrangler configs or injected through safe environment-specific config templates that are not rewritten by shell scripts during deployment.

### Target Workflow

The default deploy workflow should be short:

```text
checkout
setup pnpm/node
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
wrangler check/types for each Worker config
wrangler deploy for frontend-worker
wrangler deploy for read-worker
wrangler deploy for sync-worker
wrangler deploy for media-worker
```

Optional dry-run deploy checks may run before deploy, but they should use each app's own config directly.

### Removed Workflow Steps

The new workflow must remove these old patterns:

- `wrangler kv namespace create` during normal deploy.
- `wrangler r2 bucket create` during normal deploy.
- `wrangler kv namespace list` to discover IDs during normal deploy.
- Python or shell edits that replace IDs inside Wrangler config.
- `wrangler secret put` loops during every deploy.
- `curl https://api.cloudflare.com/client/v4/.../schedules` schedule diagnostics.
- `curl -X PUT .../schedules` schedule creation.
- Public `curl https://<worker>/__cron/sync` as a sync trigger.

### Native Cron Requirement

`sync-worker` must implement `scheduled(event, env, ctx)` and its Worker config must declare the cron schedule. The deployed Worker should run from Cloudflare scheduled events without a public HTTP cron endpoint.

The README must describe cron as native Worker scheduled events. It must not tell users to manually call a `/__cron/sync` URI or rely on a public cron secret.

### GitHub Permissions

The workflow should explicitly set minimum GitHub token permissions. For a simple deploy pipeline, that usually means read-only repository contents plus whatever is needed by the selected deploy action. Before writing the workflow, verify the exact permissions required by the chosen GitHub Actions and Wrangler deploy path.

Cloudflare API token permissions must be documented as two tiers:

- Initial provisioning token: can create/manage KV, R2, Queues, Workers, and required bindings.
- Routine deploy token: can deploy Workers and read/use existing resources.

Routine deploys should not require broad resource creation permissions.

## Error Handling

- Public errors use sanitized messages.
- Cache statistics can show sanitized image download or upstream subject-detail errors.
- Raw response bodies from authenticated bgm.tv calls must not be exposed on `/cache`.
- Queue job failure writes status `failed` and `last_error`.
- Temporary upstream failures do not delete previous successful image or subject meta data.

## Testing Plan

### Domain Tests

- Snapshot image shape uses `images.common` and `images.large`.
- No legacy `images.hash` or `images.hash_large` fields.
- NSFW subject meta map writes `nsfw: true` for collections.
- NSFW subject meta map writes `nsfw: true` for calendar entries.
- Missing subject meta writes `nsfw: false`.
- Cache statistics aggregation counts common and large statuses independently.

### BGM API Tests

- `GET /v0/subjects/{subject_id}` uses optional bearer when a token exists.
- 200 subject detail maps `Subject.nsfw`.
- 404 subject detail can be classified for `not_found_or_restricted`.
- Image download returns bytes and content type without swallowing successful data.

### Media Worker Tests

- Downloads common and large independently.
- Hash is SHA-256 lowercase hex of bytes.
- R2 key is `images/{hash}/original`.
- Successful image download writes `cached` status.
- Missing source URL writes `missing_source`.
- Failed download writes sanitized `failed` status.
- Subject 404 writes `nsfw: true` and `reason: not_found_or_restricted`.

### Frontend/Widget Tests

- Frontend image URL uses `images.common.uri`.
- Cache page renders status groups.
- Footer includes `/cache`.
- Footer includes commit link when build SHA exists.
- Analytics snippets are build-time conditional.
- Webmaster meta tags are build-time conditional.

### Worker Integration Tests

- `frontend-worker` calls `read-worker` through service binding.
- `sync-worker` enqueues media jobs without downloading images inline.
- `sync-worker` has a `scheduled()` handler and no public cron trigger route.
- `media-worker` consumes queue jobs and updates KV/R2.
- `read-worker` returns cache stats without secrets.

## README Updates Required

README must be rewritten for the new architecture. It must document:

- Monorepo package layout.
- Four Worker deployment units.
- `packages/widget` as the single home for frontend assets, templates, shared footer, and theme CSS.
- Cloudflare KV, R2, Queue, and service binding setup.
- Initial provisioning versus routine deploy permissions.
- Native Worker cron schedule through `scheduled()` and `triggers.crons`.
- Queue-based media processing.
- Image cache public URI, R2 key, and hash calculation.
- `images.common` and `images.large` snapshot shape.
- `/cache` public statistics page.
- Footer build commit link.
- Analytics env vars.
- Webmaster verification env vars.
- NSFW behavior.

README must not describe removed legacy fields, old single Worker deployment, old image field names, or unimplemented endpoints.

README must not instruct users to edit the removed standalone theme directory, because theme assets now live under `packages/widget`.

README must not instruct users to `curl` a cron URI for normal sync. Manual sync by public HTTP endpoint is removed from the target architecture.

## Implementation Order

1. Create monorepo app/package layout.
2. Move pure domain logic into `packages/domain`.
3. Move bgm.tv client into `packages/bgm-api`.
4. Move storage adapters and key builders into `packages/storage`.
5. Move top-level public and theme frontend assets into `packages/widget`.
6. Implement the shared footer component/template partial in `packages/widget`.
7. Build `read-worker`.
8. Build `frontend-worker`.
9. Build `sync-worker` with queue producer.
10. Build `media-worker` with queue consumer.
11. Implement new image cache schema.
12. Implement NSFW subject meta enrichment.
13. Implement public `/cache` page.
14. Implement footer build metadata through the shared footer.
15. Implement build-time analytics and webmaster injection after verifying official snippets.
16. Rewrite GitHub Actions deploy workflow to remove deployment-time provisioning, secret upload loops, config rewriting, schedule `curl`s, and public cron URI assumptions.
17. Rewrite README and deployment docs.
18. Run full tests, typecheck, Wrangler config validation, and dry-run deploy checks.

## Open Decisions

None. The cache statistics page is public. Queue is the selected media processing mechanism. Legacy compatibility is out of scope. Cron is native Worker scheduled events, not a public HTTP endpoint.

## Self-Review

- No placeholder sections.
- NSFW solution from `docs/tmp/nsfw-solution.md` is included.
- The Worker count is intentionally limited to four.
- Queue is the selected media execution path.
- New image shape removes legacy fields.
- Public `/cache` is included and secret-safe.
- Build-time analytics and webmaster injection are included.
- CI/CD simplification and native cron requirements are included.
- README obligations are explicit.
