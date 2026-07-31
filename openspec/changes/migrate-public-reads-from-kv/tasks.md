## 1. Resumable Legacy Import

- [x] 1.1 Implement a maximum-50-subject migration batch using the current D1 collection set and app_state cursor
- [x] 1.2 Map legacy detail/meta/image/refresh records into D1 only when no newer row exists and reuse existing image R2 keys
- [x] 1.3 Add interruption, replay, missing-key and stale-overwrite migration tests

## 2. Shadow Equivalence Gate

- [x] 2.1 Build stable legacy-vs-R2 comparison for all collection fields, subject IDs, calendar, summary, images and NSFW
- [x] 2.2 Persist shadow streak and sanitized diff summary, resetting streak on any business difference
- [x] 2.3 Enforce seven consecutive daily matches and KV-budget acceptance before pointer cutover is permitted

## 3. Public Read Cutover

- [x] 3.1 Add verified PublicSnapshotV1 R2 loading and Cache API storage while preserving existing API response shapes and pagination
- [x] 3.2 Implement fallback order of last verified cache then legacy KV manifest for pointer/R2/schema/hash failures
- [x] 3.3 Extend health with non-breaking generation, source, budget and migration summaries
- [x] 3.4 Preserve the legacy image_status/rating response contract in R2 snapshot items and cover it in the shadow comparison

## 4. Rollback and Cleanup

- [x] 4.1 Add explicit cutover and rollback operations that never require reverting D1 rows
- [x] 4.2 Implement a 14-day read-only observation gate and maximum-100-key daily legacy cleanup cursor
- [x] 4.3 Preserve at least one verified R2 generation and document cleanup stop/recovery procedures

## 5. Verification and Production Acceptance

- [x] 5.1 Run migration, shadow, fallback, API compatibility, full repository and Wrangler deployment gates
- 5.2（生产时间门禁，pending）Observe seven production shadow runs, perform cutover, observe 14 days, then enable cleanup with KV writes below the accepted budget — 见 `docs/superpowers/reports/2026-07-31-migrate-public-reads-from-kv-verify.md` 的 Explicitly pending production evidence
- [x] 5.3 Commit and push each accepted task atomically and synchronize all user-facing architecture/runbook documentation
