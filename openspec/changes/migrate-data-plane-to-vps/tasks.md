## 1. PostgreSQL Authority

- [x] 1.1 Verify PostgreSQL client/migration APIs, add the VPS application package, and implement versioned schema migrations plus advisory-lock tests using TDD
- [x] 1.2 Implement provider-neutral repositories for collection, calendar, media, sync-run, and publication state with transaction, deletion-safety, replay, and secret-persistence tests

## 2. VPS Synchronization Runtime

- [x] 2.1 Reuse the verified bgm.tv client/domain logic to implement complete collection/calendar input, bounded retry, primary failure protection, and normalized diff tests
- [x] 2.2 Implement the one-shot run coordinator, heartbeat/terminal outcomes, no-change behavior, media refresh lifecycle, and concurrent-run exclusion with RED-to-GREEN tests

## 3. Immutable R2 Publication

- [x] 3.1 Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests
- [x] 3.2 Implement snapshot upload, readback verification, replay-safe pending publication, final manifest switching, and failure-injection tests

## 4. Cloudflare Read Cutover

- [x] 4.1 Add R2 manifest/snapshot validation to the Read Worker while preserving public response shapes and parameter contracts
- [x] 4.2 Implement fallback order R2 to last verified Cache API to migration-period legacy KV, including corrupt, missing, rollback-generation, and VPS-offline tests; document rollback fencing as best effort from a locally available, revalidated envelope, without a cross-isolate/POP global guarantee

## 5. Backup and Restore

- [x] 5.1 Verify pg_dump/pg_restore and R2 client contracts, then implement custom-format backup upload, checksum manifest, partial-success semantics, and tests
- [x] 5.2 Add an injectable `runOnce` composition that wires `createBackup` and requires a notifier port; implement 30-UTC-day/monthly retention candidate selection without R2 deletes and a safe empty-database restore-verification flow. Rebuild database-backed snapshot fields from PostgreSQL, use only the verified immutable snapshot's weekday labels and historical array ordering/identity indexes (not stored in PostgreSQL), and fail closed if baseline identities are absent, extra, or mismatched. Defer executable sync to 6.2 and restore command/input syntax to 9.3.

## 6. Feishu Run Notifications

- [ ] 6.1 Verify the official Feishu webhook/signature contract and implement success, no-change, partial, failure, and skipped notification payload tests
- [ ] 6.2 Implement bounded notification delivery, notification_failed persistence, previous-failure summary, and credential/error redaction tests; inject the real Feishu notifier and activate the executable sync entrypoint.

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
