## Why

Cloudflare Free Plan limits now shape the data pipeline more than the product requirements: routine synchronization depends on four Workers plus Workflow, Queue, Durable Objects, D1, KV, and two R2 buckets. Moving write-side processing to an existing VPS and provider-neutral PostgreSQL removes those quota-driven coordination paths while retaining Cloudflare's useful public-read and CDN boundary.

## What Changes

- Add a one-shot TypeScript synchronization runtime executed from Docker Compose by a VPS host cron, with PostgreSQL advisory locking and durable run records.
- Replace D1/KV/Workflow/Queue authority with provider-neutral PostgreSQL reached only through `DATABASE_URL`; tokens and infrastructure credentials remain runtime secrets.
- Publish canonical, immutable public snapshots to R2 and switch `public/manifest.json` only after upload and hash verification; unchanged content performs no publication.
- Change the Read Worker to load and validate the R2 manifest and snapshot, then fall back to its last verified Cache API copy and, during migration, the legacy KV source.
- Add post-publication PostgreSQL backups to private R2 storage, an explicit retention policy, and a tested restore path.
- Send a sanitized Feishu webhook result for every scheduled run, including no-change, partial-success, and failure outcomes.
- Add minimal Alpine-based production and opt-in debug container targets, Docker Compose deployment assets, and GHCR workflows that publish immutable git-SHA tags.
- Freeze `harden-workflow-request-budget`, `adopt-d1-r2-incremental-sync`, and the remaining production gates in `migrate-public-reads-from-kv`; their Cloudflare write-path work is superseded but their verified snapshot/read behavior remains implementation evidence.
- **BREAKING**: after the staged cutover and observation gates, routine synchronization no longer runs through Cloudflare Workflow, Queue, Durable Objects, D1, or KV write paths.

## Capabilities

### New Capabilities

- `vps-data-sync-runtime`: One-shot scheduled synchronization, complete-input gating, bounded retry, concurrency exclusion, and durable run outcomes on the VPS.
- `postgres-authoritative-state`: Provider-neutral PostgreSQL schema, migrations, transactions, collection/media/calendar authority, and publication metadata.
- `r2-snapshot-publication`: Canonical snapshot hashing, immutable R2 objects, monotonic generation, verified manifest switching, and no-change publication behavior.
- `postgres-r2-backup`: Post-publication custom-format database backups, private R2 manifests, retention, and restoration verification.
- `sync-run-notifications`: Sanitized Feishu notifications for every terminal synchronization outcome without coupling notification delivery to publication success.
- `vps-container-delivery`: Minimal Alpine production/debug images, hardened one-shot Compose execution, immutable GHCR SHA delivery, and manually approved VPS rollout.

### Modified Capabilities

- `durable-sync-workflow`: Replace Cloudflare Workflow/Cron/Queue orchestration requirements with the VPS one-shot runtime while preserving complete-input, replay safety, monotonic publication, and observability guarantees.
- `cache-refresh-lifecycle`: Replace Queue and Durable Object media serialization with PostgreSQL-owned refresh state and synchronization-run concurrency control while preserving stale-serving and no-op behavior.
- `public-read-contracts`: Make the verified R2 manifest/snapshot the primary public source without changing existing public URL or response contracts.
- `project-quality-gates`: Add PostgreSQL integration, snapshot failure injection, backup restoration, container-content, Compose hardening, Feishu redaction, and GHCR reproducibility gates; retire write-path-specific Cloudflare deployment gates after cutover.
- `sync-consistency`: Preserve all-or-nothing collection/calendar publication and deletion safety across the PostgreSQL transaction and R2 publication boundary.

## Impact

The change adds a VPS synchronization application, PostgreSQL migrations/adapters, R2 publisher and backup modules, Feishu notification support, Docker/Compose assets, and GHCR workflows. It modifies the existing Read Worker and shared domain/storage contracts, and later removes routine deployment of the Cloudflare sync/media write path. The public frontend routes and response shapes remain compatible. Database provider selection, automatic SSH deployment, public VPS endpoints, real-time refresh, frontend redesign, and automatic Cloudflare resource deletion are out of scope.
