# Legacy state import (#73)

Read-only import of v2 legacy KV metadata into the portable builder SQLite
checkpoint. Part of the #73 migration pipeline; **no cutover and no production
write** — the published public store is never touched.

## Export side

The `kv-export.json` input is produced by the read-only Cloudflare export CLI
(#73); it lists the legacy KV keys and reads their values through the Cloudflare
API, writing only the local file:

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-legacy-export.ts \
  --out kv-export.json [--account-id <id>] [--namespace-id <id>] [--prefix <p>] [--page-limit N] [--allow-empty]
```

- Credentials come from the documented operator env (`CLOUDFLARE_ACCOUNT_ID`,
  `AIRING_CAL_KV_NAMESPACE_ID`, `CLOUDFLARE_API_TOKEN`) or the flags.
- Endpoints (verified against the Cloudflare API reference 2026-10-17): key
  listing `GET /accounts/{account_id}/storage/kv/namespaces/{namespace_id}/keys`
  (paginated with `cursor`, `limit` 10..1000) and value reads
  `POST .../namespaces/{namespace_id}/bulk/get` with `{keys, type: 'json'}`
  (≤100 keys per request).
- Defaults to the four migration prefixes (`subject:detail:`, `subject:meta:`,
  `image:status:`, `subject:refresh:`); `--prefix` narrows the export.
- An empty result fails the run unless `--allow-empty` is passed, so a wrong
  namespace id cannot silently produce an empty migration input.
- No Cloudflare write, no `public/` store access, exit `1` on usage/API errors.

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

## Pipeline status (#73)

1. **Export** (read-only Cloudflare KV → `kv-export.json`): `portable-legacy-export.ts`, see above.
2. **Import** (KV export → builder SQLite `subject_media`): `portable-legacy-state-import.ts`, this document.
3. **Shadow gate** (normalized legacy vs published snapshot, seven-match cutover gate): [`shadow-gate.md`](./shadow-gate.md).

Still open: the owner-approved cutover / rollback runbook execution.

### Why there is no D1/R2 export adapter (decision, 2026-10-17)

The #73 design text mentions "v2 D1/R2/KV read-only export". For this pipeline the
D1 and R2 halves are deliberately not implemented, and that is not a gap in the
migration path:

- **R2** holds only image binaries, and the design keeps them in place ("keep
  existing image R2 keys, do not copy binaries"). The portable builder reuses the
  same `images/<hash>/…` keys, so no R2 read/export step is needed — the
  Cloudflare worker and the portable gateway both serve the existing objects.
- **D1** is the v2 authoritative collection state, but the *subject set* the
  import needs is already derived from the published `PublicSnapshotV1`
  (`--snapshot`), which the shadow gate proves equivalent to the legacy export
  before any cutover. Reading D1 would additionally require inventing an
  "active rows" semantic (`deleted_at IS NULL`) that the repository does not use
  anywhere, and its value would be re-checked by the same shadow gate.
- The **KV** export is the only part carrying data the portable store cannot
  derive (detail/meta/image-status metadata), which is why
  `portable-legacy-export` exists.

Revisit only if a cutover needs subject ids before a verified snapshot exists
(e.g. bootstrapping an empty instance from v2 D1 alone).
