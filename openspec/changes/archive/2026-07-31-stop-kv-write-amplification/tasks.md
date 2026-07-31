## 1. Regression Baseline

- [x] 1.1 Add write-observing KV and Queue test doubles that count subject refresh, metadata, image status and Workflow writes
- [x] 1.2 Add a failing 659-subject unchanged-cache regression proving the current workflow produces forbidden media jobs and writes

## 2. Bounded Refresh Planning

- [x] 2.1 Restore component-level 6-to-8-day due selection before enqueue and preserve Workflow replay idempotency
- [x] 2.2 Implement priority ordering, daily soft limit 50, hard limit 100 and deterministic cold seven-day shard selection
- [x] 2.3 Make media consumer skip unchanged metadata, image status and refresh terminal writes while preserving errors and tombstones

## 3. Daily Scheduling and Observability

- [x] 3.1 Verify Wrangler Cron configuration syntax and change the production trigger to daily 04:00 Asia/Shanghai
- [x] 3.2 Add closed run counters for candidates by priority, planner selection, logical grants, budget-deferred, confirmed/uncertain and skipped subjects without per-subject metric state
- [x] 3.3 Update README, architecture and deployment assertions for daily sync, QoS and zero-write semantics

## 4. Verification and Release

- [x] 4.1 Run focused sync/media/storage tests, full typecheck/test/build and Wrangler dry-runs
- 4.2（生产时间门禁，pending）Commit and push each accepted task atomically, deploy the converged SHA, and record a 24-hour production KV-write acceptance check — 代码已随 `adopt-d1-r2-incremental-sync` 合并并在 3aaee52 上线；24h KV 写验收见 `docs/superpowers/reports/2026-07-22-stop-kv-write-amplification-verify.md` 的 Explicitly pending production evidence
