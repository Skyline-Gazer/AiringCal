---
comet_change: migrate-data-plane-to-vps
role: technical-design
canonical_spec: openspec
---

# VPS Data Plane Migration Design

## 1. Purpose and boundaries

This change moves all scheduled writes and upstream data processing from Cloudflare to a one-shot TypeScript container on a VPS. Cloudflare remains the public delivery boundary: Frontend Worker routes public requests, Read Worker validates published data, and R2 stores immutable snapshots and images.

The new runtime has no public HTTP listener. It connects outbound to bgm.tv, provider-neutral PostgreSQL, R2's S3-compatible endpoint, and a Feishu custom-bot webhook. PostgreSQL is selected at deployment time through `DATABASE_URL`; no provider SDK or control-plane API is part of the application.

The first release does not automatically deploy to the VPS, delete Cloudflare resources, provide real-time refresh, or change frontend routes/response shapes.

## 2. Selected architecture

### 2.1 Repository boundaries

The implementation uses three layers:

1. Shared domain/protocol code retains public snapshot building, canonical hashing, complete-fetch validation, normalized comparison, refresh selection, and redaction rules. This layer has no Node, PostgreSQL, Cloudflare, or S3 client dependency.
2. A reusable sync core defines orchestration ports for authoritative state, upstream fetches, media objects, public publication, backup, notification, clock, and logging. It owns stage order and terminal-result classification but not infrastructure calls.
3. `apps/vps-sync` is the Node composition root. It parses secrets/config, creates PostgreSQL/S3/Feishu adapters, runs migrations, acquires the database lock, invokes the sync core once, emits one structured terminal result, and exits.

Cloudflare-specific D1, KV, Queue, Workflow, and Durable Object adapters remain isolated in their existing applications during migration and are never imported by `apps/vps-sync`.

### 2.2 Rejected alternatives

- A dual-runtime `sync-worker` was rejected because Node/Worker branching would preserve the coupling this migration is intended to remove.
- Directly copying the D1 row model was rejected because it repeats full subject JSON per user's collection row and wastes hosted-database free-tier storage.
- Go or Rust was rejected because this job is low-frequency and I/O-bound, while rewriting verified TypeScript contracts would add substantial regression risk.
- A persistent scheduler container was rejected because host cron plus a one-shot container is smaller, more observable, and easier to roll back.

## 3. Runtime command and lifecycle

The production image exposes one application command with explicit operations:

- `sync --mode=shadow|live --source=scheduled|manual` runs one synchronization.
- `migrate` applies forward-only SQL migrations under a migration advisory lock.
- `backup` creates and uploads a database backup without running upstream synchronization.
- `restore-verify` restores a selected dump into an explicitly supplied empty target database and validates it; it cannot target the configured production database.

The scheduled path is:

1. Host cron obtains an OS-level non-blocking lock and starts `docker compose run --rm sync`.
2. The process validates configuration without logging secret values.
3. Migrations run before the business lock is requested.
4. The process attempts a PostgreSQL session advisory lock. Failure produces a persisted/skipped outcome without upstream or R2 writes.
5. A `sync_runs` row is created and becomes the source of health/notification state.
6. Complete collections and calendar input is fetched and validated.
7. Authoritative collection/calendar state is committed in one database transaction.
8. Due subject detail, metadata, and images are refreshed with bounded concurrency.
9. The public snapshot is built from committed PostgreSQL state and published or classified no-change.
10. A database backup is attempted only after snapshot publication succeeds or business content is verified unchanged. Runs that fail or skip before reaching either milestone do not trigger a backup. Media degradation does not suppress backup after a successful publication; backup failure independently contributes to a terminal partial result.
11. A terminal run status is persisted and a Feishu message is attempted.
12. The advisory lock and database pool are closed; the process exits with the documented status code.

`success` and `no_change` exit successfully. `partial` exits non-zero so cron/monitoring can detect degradation while preserving a published snapshot. `failed` exits non-zero. `skipped` exits successfully because another healthy run owns the work.

## 4. PostgreSQL authority

### 4.1 Schema ownership

The normalized model contains:

- `users`: stable configured user identity and non-secret upstream identifiers.
- `subjects`: canonical subject projection, content hash, upstream update marker, first/last observation, and tombstone state.
- `collection_items`: `(user_id, subject_id)` collection state, progress, rating, tags, comment, upstream update marker, content hash, and missing/deleted observations.
- `subject_media`: per-subject detail/metadata/image references, component hashes/status, observed generation, retry/tombstone timestamps, and last successful timestamps.
- `calendar_entries`: normalized calendar day and subject membership for the latest complete observation.
- `sync_runs`: run identity, source/mode/stage/status, heartbeat, counts, stage durations, build metadata, sanitized error, and terminal component results.
- `publications`: singleton verified publication plus at most one replayable pending publication, with generation, content hash, object key, timestamps, run identity, and claim state.
- `schema_migrations`: applied migration name/checksum/time.

Access tokens, refresh tokens, database URLs, webhook URLs/secrets, R2 credentials, raw authorization headers, and unredacted upstream response bodies are forbidden in every table and JSON column.

### 4.2 Transactions and deletion safety

The collection/calendar transaction begins only after all configured users and all pages pass the existing complete-fetch boundary. A page count/offset/total inconsistency, duplicate subject, premature empty page, invalid calendar projection, or primary-account failure aborts before business writes.

The transaction upserts normalized subjects and collection items, records first missing observations, confirms deletion only under the canonical two-successful-complete-observations rule, replaces the current calendar set, and checkpoints the run. No network or R2 call occurs while this transaction is open.

This rule already exists in `packages/domain/src/collection-diff.ts` (`planCollectionDiff`): the first complete missing observation persists `missing_since`, and a later distinct complete observation confirms `deleted_at`. The PostgreSQL implementation reuses that domain rule and must persist equivalent per-`(user_id, subject_id)` `missing_since`/`deleted_at` state transactionally; it must not introduce a separate consecutive-missing counter.

The first release assumes a single scheduled writer but still uses row constraints and advisory locks so manual/replayed runs cannot corrupt state.

### 4.3 Migrations

Migrations are numbered, forward-only SQL files with immutable checksums. The runner acquires a distinct migration advisory lock, applies each migration in a transaction where PostgreSQL permits it, and refuses a checksum mismatch. Runtime startup refuses to run business work when the schema is behind or ahead of the application-supported version.

Rollback deploys an older compatible image; it does not reverse or delete applied migrations.

### 4.4 Supported PostgreSQL baseline and connection mode

The supported server baseline is PostgreSQL 18. Production and integration environments must stay on a maintained `18.x` patch release. A later PostgreSQL major is not adopted automatically: it requires an explicit compatibility review and a fresh real-server integration run before becoming supported. PostgreSQL 17 compatibility is unverified and is not an acceptance gate for this approved baseline.

`DATABASE_URL` remains the sole, provider-neutral TLS connection contract; the application does not use a provider SDK or control-plane API. The migration runner and runtime session advisory locks require a direct, session-preserving connection. A transaction-pooled endpoint is not acceptable because it can change the server session between transactions and therefore cannot preserve session-level advisory locks. The same direct connection requirement applies to future migration and backup work.

The existing real-server evidence is recorded in [the PostgreSQL 18 integration evidence](../../verification/2026-08-31-vps-sync-postgresql-18-integration.md). It validates the implemented Node `pg` path, not a `psql` or container path.

## 5. Complete fetch and retry policy

The existing bgm.tv API client and `docs/example/api/bgm-api.json` remain the endpoint/schema authority. Implementation must re-verify every endpoint, method, parameter, and authentication mode before adapting the client to the Node runtime.

The Node adapter must disable the client's built-in retry by constructing `BgmClient` with `maxGetRetries: 0`, then apply the policy below in a single outer layer. The adapter also wraps `BgmHttpError`/`BgmTimeoutError`/`BgmNetworkError` so that persisted/notified errors carry only the sanitized fields below — never the client's raw message, which embeds URLs and response-body fragments.

Retry classification is centralized:

- 401 and 403 are terminal authentication errors and are not retried.
- 404 is terminal only for subject detail/media lookup and creates a conservative tombstone; it is not accepted for collection/calendar completeness.
- 429, 5xx, timeout, connection reset, and transient DNS/network failures retry at most three attempts.
- A valid server retry delay is respected within a configured maximum; otherwise bounded exponential backoff with jitter is used.
- Invalid JSON or schema mismatch is a terminal upstream-contract failure for the current run.

Only sanitized category, stable code, attempt count, and stage are persisted or notified.

## 6. VPS-owned media lifecycle

The VPS is the only producer for subject detail, metadata, and image R2 objects after cutover. The Cloudflare Media Worker and Queue remain live only during shadow migration and are stopped before the VPS becomes the live writer.

During shadow mode the VPS writes media objects only under a `shadow/` namespace prefix and never to live `images/` keys; content-hash keys make live collisions harmless only after cutover, when the legacy Media Worker and Queue are stopped before the VPS becomes the live writer.

Due media candidates use the existing deterministic refresh staggering and priority concepts. Refresh work uses bounded concurrency and a per-subject PostgreSQL row/advisory lock. Each candidate carries `observed_at` and `run_id`; a result older than the stored fence is obsolete before any database or R2 mutation.

Image processing is:

1. Validate the upstream URL and fetch response using the verified bgm client contract.
2. Enforce accepted HTTP status, MIME class, and bounded byte size before storage.
3. Compute SHA-256 from received bytes.
4. Reuse an existing `images/<hash>/original` object when the authoritative state already references the same content.
5. Upload new bytes before committing the new PostgreSQL image reference.
6. Preserve the last successful reference on transient failure, invalid content, or upload failure.

Media component results are independent. A missing image source does not erase valid detail/metadata. A transient failure sets `next_retry_at`; a confirmed 404 sets a bounded tombstone. Identical content produces no PostgreSQL update and no R2 PUT.

Media failure never blocks a complete collection/calendar publication. The snapshot uses last-known-good media state, the run becomes `partial`, and Feishu reports the failed count and retry state.

## 7. Immutable public publication

### 7.1 Snapshot contract

The existing `PublicSnapshotV1` payload remains the public data contract. Its canonical business payload determines `content_hash`; runtime fields and publication time do not. The immutable object key remains:

```text
snapshots/v1/<generation>-<content_hash>.json
```

This avoids frontend projection changes and lets existing parser/shadow-compare tests remain authoritative.

`PublicSnapshotV1.published_at` remains a Unix-second integer and is part of the public response shape; it is excluded from the canonical business payload and therefore never affects `content_hash`. The manifest's `published_at`/`source_observed_at` are UTC ISO-8601 strings derived from the same instant as the snapshot's numeric `published_at` and the run's `observed_at`. Identical business content fetched at a different wall-clock time produces the same `content_hash` and snapshot key.

### 7.2 Manifest contract

R2 `public/manifest.json` is a new exact-key `PublicSnapshotManifestV1`:

```ts
interface PublicSnapshotManifestV1 {
  schema_version: 1
  generation: number
  snapshot_key: string
  content_sha256: string
  published_at: string
  source_observed_at: string
  item_count: number
  git_sha: string
}
```

Times are UTC ISO-8601 strings. `snapshot_key` must exactly match generation and hash. `item_count` must match snapshot summary total. `git_sha` is a full 40-character lowercase commit SHA. `snapshot_key` embeds the snapshot's numeric generation and `content_hash`; the snapshot object's numeric `published_at` and the manifest's ISO `published_at` describe the same instant in different encodings.

`git_sha` is injected at image build time as a Docker build `ARG GIT_SHA` baked into a compiled constant; the container has no `.git`. The same constant feeds the manifest, the backup manifest, and the Feishu message. CI passes `GITHUB_SHA`; local builds must supply it explicitly or the build fails.

### 7.3 Publication state machine

Under the business advisory lock:

1. Build generation-zero canonical content and compare its hash with the verified publication.
2. If equal, clear only an unclaimed stale pending record and return `no_change` without generation allocation or R2 writes.
3. For changed content, allocate `verified_generation + 1` and persist a pending row with run/content identity.
4. Upload the immutable snapshot object through the S3-compatible adapter.
5. Read the object back, parse it with the shared `PublicSnapshotV1` parser, and verify generation/hash/key.
6. Upload canonical manifest bytes to `public/manifest.json`.
7. Read back and validate the manifest.
8. Mark the pending publication verified in PostgreSQL.

If any R2 step fails, the old manifest remains the public authority and the pending row remains replayable. A later run may resume an exact pending candidate or supersede an unclaimed failed candidate at the same next generation; it cannot skip, reuse a conflicting generation, or replace a newer verified publication.

Shadow mode writes a shadow manifest/object namespace and comparison evidence but never updates `public/manifest.json`.

## 8. Cloudflare read path

Read Worker reads `public/manifest.json` from its data R2 binding and validates exact keys, schema, timestamps, full git SHA, item count, monotonic generation, hash, and snapshot key. It then loads and parses the immutable snapshot.

Each edge location stores a last-verified manifest/snapshot envelope in Cache API. On R2 failure or invalid data, Read Worker uses the envelope only after re-validating both objects. During migration, absence of any verified R2 source falls back to the complete legacy KV snapshot; fields are never mixed between sources.

The public URL and response shapes remain unchanged. Public request handlers have no VPS endpoint, database driver, or database credential. Image requests continue to read content-addressed R2 objects and apply public caching.

## 9. Backup and retention

Backup runs after snapshot publication or a verified no-change result. The planned production image will contain a PostgreSQL 18 client for custom-format `pg_dump`/`pg_restore` compatibility. CLI contract validation and a real backup/restore drill remain pending; this design does not represent those future commands as implemented or verified.

This condition is evaluated at the backup step, before the terminal run status is persisted; it is not conditioned on the final run status. A backup whose own upload or manifest step fails has still been attempted, and that failure contributes to a terminal `partial`.

The task streams a dump through a bounded temporary directory, computes SHA-256 and byte count, uploads the dump, then uploads a JSON manifest containing database schema version, run ID, git SHA, creation time, object key, size, and checksum. Neither file contains connection details or application secrets outside the database's permitted business data.

Retention selection is pure and testable: keep the newest 30 daily restore points and the chronologically last successful backup for every earlier calendar month. Cleanup lists an explicit backup prefix, validates each key against the backup-key grammar, and deletes only the computed set. Listing or parsing uncertainty disables deletion for that run.

`restore-verify` requires a separate target `DATABASE_URL`, proves the target is empty and not equal to production, restores one selected dump, runs schema/row-count/public-snapshot checks, and never publishes or sends user-facing data.

### 9.1 PostgreSQL references

- PostgreSQL 18 release and supported-version reference: <https://www.postgresql.org/docs/18/release-18.html>
- PostgreSQL 18 `pg_dump` reference for the pending backup implementation: <https://www.postgresql.org/docs/18/app-pgdump.html>
- Neon pooling guidance explains why transaction pooling cannot carry session advisory locks and recommends direct connections for migrations and `pg_dump`: <https://neon.com/docs/connect/connection-pooling>

## 10. Feishu notification and observability

The notifier receives a sanitized terminal result rather than raw exceptions. Each message includes run ID/status, source/mode, source and publication times, generation/hash, collection/media change counts, stage durations, publication/backup outcomes, git SHA, Node/Alpine metadata, retry summary, and a stable sanitized error category when applicable.

Webhook signing is supported when a secret is configured and omitted otherwise, following the verified official contract. The webhook URL and signature secret exist only in runtime configuration.

Notification is attempted after persisting the business terminal result. Failure updates `notification_failed` separately and never changes publication or backup state. The next successful notification includes a compact note about the previous undelivered terminal result.

Structured logs use the same sanitized event model and write to stdout/stderr for Docker/host collection.

The VPS sync application additionally supports optional Sentry tracing through `@sentry/node`. Sentry is disabled when `SENTRY_DSN` is absent. When enabled, the one-shot run and its existing coordinator stages emit manually named spans with only allow-listed operational attributes: mode, source, stage, terminal status, bounded counts, durations, and git SHA. Raw exceptions, URLs, request or response bodies, usernames, subject IDs, database identifiers, tokens, webhook values, and R2 credentials are never attached. Automatic HTTP/database instrumentation and PII collection remain disabled so trace propagation cannot leak into bgm.tv, PostgreSQL, R2, or Feishu calls.

Tracing is an injected, SDK-neutral port at the coordinator boundary. The Node adapter initializes the SDK with an explicitly parsed `SENTRY_TRACES_SAMPLE_RATE` (default `1` for this low-frequency daily job), wraps the root run and individual stage operations, and attempts one bounded flush before the process exits. Missing or invalid tracing configuration, initialization failure, span failure, and flush failure all fail open: the business operation still runs exactly once, and its persisted result, notification result, and exit code are unchanged. Cloudflare Workers are outside this tracing scope.

## 11. Container and delivery

The Dockerfile has dependency/build stages and two final targets:

- `production`: the official `node:alpine` tag resolved at build time (this floating tag tracks Node Current, not Active LTS), with its immutable digest recorded by CI, compiled application, production dependencies, CA certificates, and minimum PostgreSQL client/runtime libraries.
- `debug`: extends production and adds only verified Alpine packages for HTTPS, DNS, TCP, process/network, and JSON diagnosis.

Production excludes source, tests, TypeScript compiler, package-manager caches, git, curl, Python, editor, jq, DNS tools, and build toolchains. It runs as non-root with a read-only root filesystem, dropped capabilities, no privileged mode, no Docker socket, no port mapping, and a bounded writable temp mount.

CI records the resolved base digest, Node, Alpine, pnpm, and full git SHA. It publishes production only as an immutable full-SHA GHCR tag plus non-authoritative discovery labels. Manual workflow dispatch may publish `<sha>-debug`. Compose rejects floating/debug production image references and uses a full SHA. The recorded digest is informational for audit. The full-SHA image tag pinned in Compose provides deployment immutability and traceability for the published artifact; it does not guarantee byte-identical rebuilds from the floating base image.

GitHub Actions builds and pushes only; it never connects to the VPS or production data services. Operators manually update the Compose SHA, pull, migrate, run shadow, and approve live operation.

## 12. Test strategy

### Unit and contract tests

- Canonical snapshot/manifest validation, exact key grammar, ISO timestamps, SHA and generation rules.
- Retry classification/redaction and terminal status derivation.
- Normalized collection/calendar diff, deletion confirmation, media candidate selection, tombstone/backoff, and last-known-good behavior.
- Backup retention and restore-target safety.
- Feishu payload/signature construction without real delivery.

### PostgreSQL integration tests

Run against a disposable real PostgreSQL instance:

- migration ordering/checksum/concurrency;
- advisory lock exclusion;
- complete-state transaction rollback;
- two-observation delete/restoration;
- per-subject stale-write fencing;
- pending/verified publication replay and generation conflicts;
- secret persistence scans;
- dump restore and regenerated snapshot equality.

SQL mocks cannot substitute for these gates.

### Failure-injection tests

- Every PostgreSQL commit/checkpoint boundary.
- R2 snapshot PUT/GET, manifest PUT/GET, corrupted/truncated bodies, stale generation, and content conflicts.
- Media download/upload failures with preservation of old references.
- Backup command/upload/manifest/retention failures.
- Feishu timeout/non-success/signature errors.

### Container and end-to-end tests

- Production/debug builds for supported architecture, image-content scan, non-root identity, read-only filesystem, temp boundary, and no listening port.
- Compose config validation and full-SHA enforcement.
- Three successful shadow runs compared field-by-field with the existing public result.
- One real backup restore drill before cutover.

## 13. Rollout and rollback

1. Merge and publish the production image without changing production scheduling.
2. Provision hosted PostgreSQL and least-privilege R2 credentials on the VPS.
3. Apply migrations and run shadow synchronization manually.
4. Require three successful normalized comparisons and one restore drill.
5. Manually switch the R2 public manifest/read mode under an explicit approval.
6. Observe seven days with legacy fallback available.
7. Disable old Cloudflare Cron, Workflow, and Queue consumer; do not delete their resources.
8. Retain legacy data resources for at least 30 days. Cleanup is a separate approved change.

Rollback restores the previous verified R2 manifest or legacy read mode and deploys a known-compatible GHCR SHA. It never reverses database migrations, deletes PostgreSQL rows, or removes R2 snapshots/backups/Cloudflare resources.
