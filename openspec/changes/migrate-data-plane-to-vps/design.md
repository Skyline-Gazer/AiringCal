## Context

The deployed data path is optimized around Cloudflare Free Plan quotas rather than the application's low-frequency, read-mostly workload. The repository already contains reusable TypeScript API/domain logic and a verified R2 snapshot reader, while the write path is split across Workflow, Queue, Durable Objects, D1, KV, and R2. The target keeps Cloudflare in the public request path but makes an existing VPS the only scheduled compute node and an interchangeable hosted PostgreSQL database the authority.

## Goals / Non-Goals

**Goals:**

- Run complete, observable, mutually exclusive data synchronization as a one-shot VPS container.
- Keep PostgreSQL provider-neutral and keep all public requests independent of the VPS/database.
- Publish immutable, content-verified R2 snapshots through a monotonic manifest.
- Back up PostgreSQL to private R2 and notify Feishu after every run.
- Deliver minimal Alpine production and opt-in debug images through immutable GHCR SHA tags.
- Preserve public routes and response shapes during a staged, reversible cutover.

**Non-Goals:**

- Hosting a public frontend or API on the VPS.
- Cloudflare-to-PostgreSQL connections, provider-specific database SDKs, or real-time refresh.
- GitHub Actions SSH deployment, automatic deletion of existing Cloudflare resources, or frontend redesign.

## Decisions

1. A host cron invokes `docker compose run --rm sync`; the container is one-shot and takes a PostgreSQL advisory lock. This avoids another scheduler container and makes overlapping manual/scheduled runs safe. A continuously running service was rejected because there is no public request workload.
2. PostgreSQL is addressed only by a direct, session-preserving TLS `DATABASE_URL`, uses versioned SQL migrations, and owns collection, calendar, media, run, and publication state. The supported baseline is maintained PostgreSQL `18.x`; future majors require explicit review and a fresh real-server integration run, and PostgreSQL 17 compatibility is unverified. Transaction pooling is rejected because it cannot preserve the session advisory locks used by migrations and runtime work. D1/KV adapters remain only for migration fallback until cutover. A provider SDK was rejected to keep Neon, Supabase, and ordinary PostgreSQL interchangeable.
3. Publication writes canonical JSON to `snapshots/v1/<generation>-<sha256>.json`, verifies it by readback, and only then replaces `public/manifest.json`. Identical content is a no-op. Directly overwriting one snapshot object was rejected because it prevents immutable caching and safe rollback.
4. The Read Worker validates manifest schema, monotonic generation, key shape, and content hash. It falls back to its last verified Cache API object and then legacy KV during migration. The browser never receives storage/database credentials.
5. A successful publication is followed by custom-format `pg_dump` to private R2. Backup failure yields partial success and never rolls back a public snapshot. Retention keeps 30 daily backups plus the last backup of each month.
6. Feishu notification is a terminal side effect for every run. Notification failure is persisted but cannot change database/publication outcome. Messages contain only sanitized summaries.
7. The Dockerfile uses official floating `node:alpine` inputs as explicitly requested, records resolved Node/Alpine/base digest metadata, and publishes immutable git-SHA GHCR outputs. The production target contains only runtime requirements; a manually triggered `-debug` target adds verified diagnostic packages.
8. Deployment remains manual on the VPS: operators update Compose to a full GHCR SHA, pull, run a shadow sync, and then approve cutover. This keeps first-release credentials and rollback outside GitHub Actions.
9. `CompleteFullFetch` preserves optional calendar-field presence, including nested rating fields, and records every user whose complete pagination was observed, including empty users. Before PostgreSQL authority, the coordinator requires observed and configured user identities to be the exact duplicate-free set and never synthesizes an unobserved empty user. For the same subject, every field actually supplied by calendar is authoritative; collection subjects may fill only absent calendar fields, while fields absent from both remain absent from PostgreSQL authority JSON and hashing. The unchanged legacy public collection shape omits partial authority ratings instead of inventing zero fields. Collection-only and calendar-only subjects remain represented, repeated cross-user collection subjects resolve deterministically in configured-user order, and projection hashing uses locale-independent code-unit key ordering.

## Risks / Trade-offs

- [A floating Alpine/Node build input can change without source changes] → Record the resolved digest and never overwrite an existing GHCR SHA image; base refreshes produce a new reviewed commit/image.
- [Hosted PostgreSQL cold start or network failure] → Use bounded retry and fail before publication; the previous R2 manifest remains active.
- [PostgreSQL commit and R2 publication are not one transaction] → Persist pending publication metadata and make upload/verification/manifest switching replay-safe.
- [VPS compromise exposes write credentials] → Use least-privilege database/R2 credentials, a private env file, non-root/read-only containers, and no public ports.
- [R2 backup shares the Cloudflare administrative boundary] → Keep backups private, verify checksums/restores, and retain PostgreSQL provider restore features as a second recovery path.
- [Legacy Cloudflare state drifts during shadowing] → Compare normalized public payloads for three successful runs and retain the old path throughout cutover observation.

## Migration Plan

1. Build the PostgreSQL/VPS path and publish only shadow snapshots while the current Cloudflare path remains live.
2. Complete at least three successful normalized comparisons and one restore drill.
3. Manually switch `public/manifest.json`; retain Cache API and legacy KV fallback.
4. Observe seven days, then disable old Cron/Workflow/Queue consumers without deleting data.
5. Retain old Cloudflare data resources for at least 30 days; cleanup requires a separate approval.
6. Rollback by restoring the previous manifest or returning the Read Worker to legacy mode; never reverse PostgreSQL migrations or delete R2 generations during rollback.

## Open Questions

None. The hosted PostgreSQL vendor remains an operational selection because the runtime contract is the standard `DATABASE_URL`.
