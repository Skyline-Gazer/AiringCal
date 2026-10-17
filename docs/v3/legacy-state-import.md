# Legacy state import (#73)

Read-only import of v2 legacy KV metadata into the portable builder SQLite
checkpoint. Part of the #73 migration pipeline; **no cutover and no production
write** — the published public store is never touched.

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-state-import.ts <kv-export.json> \
  --sqlite /data/builder.sqlite \
  [--snapshot public-snapshot.json | --subject-ids 1,2,3] \
  [--batch-size 50] [--resume]
```

## Inputs

| Input | Shape |
|---|---|
| `kv-export.json` | JSON object of exported v2 KV entries: `{ "<key>": <value> }` with keys `subject:detail:<id>`, `subject:meta:<id>`, `image:status:<id>`, `subject:refresh:<id>` (see `packages/storage/src/legacy-migration.ts`) |
| `--snapshot` | A `PublicSnapshotV1` JSON file (the published snapshot); its collection + calendar `subject_id`s are the import set |
| `--subject-ids` | Explicit comma-separated subject ids; overrides `--snapshot` |

Both a snapshot and explicit ids are optional only if the other is given.

## Behaviour

- Batches of at most **50** subjects; `--batch-size` accepts `1..50`.
- Per batch it writes `subject_media` rows and persists
  `migrate:legacy:cursor` + `migrate:legacy:summary` in `builder_kv`, so an
  interrupted run continues with `--resume` (subjects ≤ `last_subject_id` are skipped).
- Idempotent: a subject whose row already has a detail hash or image key is counted
  as `skipped_existing` and not overwritten; an imported row without detail keeps
  the existing detail (`COALESCE`, same as the v2 media writer).
- Counted but untouched: subjects without any KV record (`missing_keys`) and
  malformed records (`errored`) — a malformed record never stalls the batch.
- Resume: a `--resume` run continues the persisted summary counters and processes
  only subjects above `last_subject_id`. `errored` subjects are **not** retried by
  `--resume` (the cursor moved past them) — re-run without `--resume` to retry;
  already-imported rows are then counted as `skipped_existing`. A corrupt or
  hand-edited cursor/summary is ignored, and the run restarts the walk.
- Only SQLite is written: no D1, R2, KV, or public-store access.

`summary.updated_at` is milliseconds (the batch timestamp from
`importLegacySubjectBatch`); `cursor.updated_at` is unix seconds.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Import ran; see the JSON summary for per-subject counts |
| 1 | Bad arguments, unreadable input, or SQLite failure |

`stdout` ends with `{"status":"ok","stage":"legacy_state_import",...}`; each batch
logs `legacy_state_import_batch`.

## Rollback

Restore a pre-import checkpoint backup
(`portable-checkpoint-backup.ts` → `portable-checkpoint-restore.ts <backup.sqlite> --force`)
or re-run against a fresh SQLite file. Because the public store is never written,
no release pointer changes and v2 reads keep serving the current snapshot.

## Still open (#73)

- The export side (real v2 KV/D1/R2 read-only client) is not in the repo; the
  JSON export is produced by the operator today.
- Shadow-equivalence streak persistence + the seven-day gate: [`shadow-gate.md`](./shadow-gate.md).
- Cutover / rollback runbook execution (owner-approved, #73 DoD).
