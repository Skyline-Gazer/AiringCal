## 1. Resource Bootstrap

- [x] 1.1 Verify Wrangler D1/R2 CLI and config contracts from help, types and official docs
- [x] 1.2 Extend manual bootstrap and resource resolve to create/reuse `airing-cal-state` and `airing-cal-data` without changing runtime bindings
- [x] 1.3 Add D1 ID materialization, tests and documentation, commit/push, then run bootstrap before binding-dependent deployment

## 2. D1 State Model

- [x] 2.1 Add migrations for collection_items, subject_media, sync_runs, sync_budget and app_state without secondary indexes
- [x] 2.2 Implement typed D1 adapters, stable canonical JSON/hash helpers and row mapping tests
- [ ] 2.3 Implement atomic daily budget reservation/consumption and concurrency tests

## 3. Incremental Workflow

- [x] 3.1 Fetch complete collections/calendar and compute in-memory D1 diff that ignores runtime fields
- [x] 3.2 Implement first-missing and second-successful-missing deletion transitions with pagination-failure protection
- [ ] 3.3 Persist sync summaries and hot/cold media scheduling state without writing new legacy per-subject KV

## 4. Immutable R2 Publication

- [x] 4.1 Define and validate PublicSnapshotV1/PublicSnapshotPointerV1 and deterministic content hashing
- [ ] 4.2 Implement D1 commit → R2 put → R2 verify → KV pointer publication with no-op hash short circuit
- [ ] 4.3 Add failure-injection and replay tests proving old pointer survival and zero writes on identical input

## 5. Bindings and Deployment

- [ ] 5.1 Add D1 and data R2 bindings to internal Workers while retaining legacy bindings for compatibility
- [ ] 5.2 Apply D1 migrations before Worker deploy and extend config/dry-run/control-plane tests
- [ ] 5.3 Update README, resource tables, architecture, environment variables, deployment and rollback runbooks

## 6. Verification and Shadow Release

- [ ] 6.1 Run package and full repository gates plus Wrangler dry-runs with materialized test IDs
- [ ] 6.2 Deploy D1/R2 core in shadow publication mode, verify resource metrics and commit/push each task atomically
