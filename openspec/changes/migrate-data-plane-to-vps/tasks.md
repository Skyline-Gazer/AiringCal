## 1. PostgreSQL Authority

- [ ] 1.1 Verify PostgreSQL client/migration APIs, add the VPS application package, and implement versioned schema migrations plus advisory-lock tests using TDD
  - Node `pg` dependency/types and PostgreSQL 18 direct-TLS real-server migration/advisory-lock validation are complete. `psql --help` and Docker/CI container-specific checks remain pending and are intentionally not asserted as complete.
- [x] 1.2 Implement provider-neutral repositories for collection, calendar, media, sync-run, and publication state with transaction, deletion-safety, replay, and secret-persistence tests
  - `pnpm -F @airing-cal/vps-sync test:integration` passed on 2026-08-31 against PostgreSQL 18.6 direct TLS server (9 pass, 0 fail, 0 skipped); the evidence records all eight subtests, schema cleanup, commit identity, and unexecuted checks. Ordinary `test` skips PostgreSQL tests and is not substitute evidence.

## 2. VPS Synchronization Runtime

- [x] 2.1 Reuse the verified bgm.tv client/domain logic to implement complete collection/calendar input, bounded retry, primary failure protection, and normalized diff tests
  - Implemented in `60245ea`, corrected in `d3baec3`; focused tests 27/27, shared-client/boundary regressions and full repository checks passed. Plain Node imports both bundled upstream entries with shared error identity. Independent fix re-review approved with no outstanding findings. No live upstream or database requests in this batch; Task 2.2 and phase advancement wait for this batch's PR merge.
- [x] 2.2 Implement the one-shot run coordinator, heartbeat/terminal outcomes, no-change behavior, media refresh lifecycle, and concurrent-run exclusion with RED-to-GREEN tests
- [x] 2.3 Implement optional fail-open Sentry tracing for the VPS run and coordinator stages with disabled-by-default, redaction, exactly-once, and bounded-flush RED-to-GREEN tests
  - Implemented in `5c2ec6d`, corrected in `630d3de` and `ccdbda8`; final independent review approved with no findings. Coordinator fresh verification passed VPS 130/130, typecheck, build:check, build, emitted adapter import, OpenSpec strict and diff check. No live Sentry request was made.

## 3. Immutable R2 Publication

- [x] 3.1 Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests
- [x] 3.2 Implement snapshot upload, readback verification, replay-safe pending publication, final manifest switching, and failure-injection tests

## 4. Cloudflare Read Cutover

- [x] 4.1 Add R2 manifest/snapshot validation to the Read Worker while preserving public response shapes and parameter contracts
- [x] 4.2 Implement fallback order R2 to last verified Cache API to migration-period legacy KV, including corrupt, missing, rollback-generation, and VPS-offline tests

## 5. Backup and Restore

- [x] 5.1 Verify pg_dump/pg_restore and R2 client contracts, then implement custom-format backup upload, checksum manifest, partial-success semantics, and tests
- [ ] 5.2 Implement explicit 30-daily/monthly retention selection and an empty-database restore verification command with non-destructive key and recovery tests

## 6. Feishu Run Notifications

- [ ] 6.1 Verify the official Feishu webhook/signature contract and implement success, no-change, partial, failure, and skipped notification payload tests
- [ ] 6.2 Implement bounded notification delivery, notification_failed persistence, previous-failure summary, and credential/error redaction tests

## 7. Alpine Container and VPS Operation

- [ ] 7.1 Verify official node:alpine metadata and Alpine package names, then add multi-stage production/debug Docker targets with image-content and non-root/read-only runtime checks
- [ ] 7.2 Add SHA-pinned one-shot Docker Compose configuration, secret template, writable temporary boundary, host-cron/flock example, and local shadow-run instructions

## 8. GHCR Delivery

- [ ] 8.1 Verify GitHub Actions and GHCR contracts, then add production image CI with test gates, resolved Node/Alpine/base-digest metadata, immutable full-SHA tags, and non-overwrite enforcement
- [ ] 8.2 Add manual debug-image workflow publishing only `<git-sha>-debug`, and verify production Compose cannot select floating or debug tags

## 9. Documentation, Verification, and Cutover

- [ ] 9.1 Synchronize README, architecture, environment variables, database migrations, snapshot/backup/notification, VPS deployment, restore, rollback, and old-change supersession documentation with each code task
- [ ] 9.2 Run full repository, PostgreSQL integration, R2 failure-injection, container, Compose, GHCR-equivalent, OpenSpec strict, and documentation audit gates and record a verification report
- [ ] 9.3 Implement and test shadow comparison, restore-drill, cutover, rollback, and observation commands/runbooks without executing production cutover during Build
- [ ] 9.4 Implement and document a 30-day legacy-resource retention and separate-change approval gate; do not delete or wait on production resources during Build
