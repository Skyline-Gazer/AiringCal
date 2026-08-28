## 1. PostgreSQL Authority

- [ ] 1.1 Verify PostgreSQL client/migration APIs, add the VPS application package, and implement versioned schema migrations plus advisory-lock tests using TDD
- [ ] 1.2 Implement provider-neutral repositories for collection, calendar, media, sync-run, and publication state with transaction, deletion-safety, replay, and secret-persistence tests

## 2. VPS Synchronization Runtime

- [ ] 2.1 Reuse the verified bgm.tv client/domain logic to implement complete collection/calendar input, bounded retry, primary failure protection, and normalized diff tests
- [ ] 2.2 Implement the one-shot run coordinator, heartbeat/terminal outcomes, no-change behavior, media refresh lifecycle, and concurrent-run exclusion with RED-to-GREEN tests

## 3. Immutable R2 Publication

- [ ] 3.1 Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests
- [ ] 3.2 Implement snapshot upload, readback verification, replay-safe pending publication, final manifest switching, and failure-injection tests

## 4. Cloudflare Read Cutover

- [ ] 4.1 Add R2 manifest/snapshot validation to the Read Worker while preserving public response shapes and parameter contracts
- [ ] 4.2 Implement fallback order R2 to last verified Cache API to migration-period legacy KV, including corrupt, missing, rollback-generation, and VPS-offline tests

## 5. Backup and Restore

- [ ] 5.1 Verify pg_dump/pg_restore and R2 client contracts, then implement custom-format backup upload, checksum manifest, partial-success semantics, and tests
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
