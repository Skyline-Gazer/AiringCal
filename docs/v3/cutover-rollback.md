# Cutover and rollback runbook (#73)

> **Scope (2026-11-07): future v2→v3 Production cutover only.** The one-bucket **Development** cutover follows [`reader-delivery-cutover.md`](reader-delivery-cutover.md); the legacy dual-bucket staging real-R2 proof is complete ([#147](https://github.com/Skyline-Gazer/AiringCal/issues/147)). Neither replaces, nor is replaced by, the steps below.

Owner-approved, manual steps for switching public reads to the v3 portable
release and for rolling back. **CI never performs any step in this document**: no
production resource is created, deployed, or deleted by a merge.

## Preconditions (all must hold)

| Gate | How to check |
|---|---|
| Shadow equivalence: 7 consecutive daily matches | `tsx apps/node-jobs/src/cli/portable-shadow-gate.ts --sqlite <path> --legacy <legacy.json> --candidate <public-snapshot.json>` exits **0** |
| Legacy import complete | `portable-legacy-state-import` summary with `errored: 0` (or every `errored` subject re-run without `--resume`) |
| Operator config validates | `tsx apps/node-jobs/src/cli/airingcal-config-validate.ts <airingcal.json>` plus `airingcal-setup` emit |
| Fresh checkpoint backup | `portable-checkpoint-backup` succeeded; file present in `AIRINGCAL_BUILDER_BACKUP_DIR` |
| Real-bucket publish safety verified | Immutable put is a no-op on re-publish, changed bytes are rejected, stale `If-Match` pointer commit conflicts (see [`cloudflare-read-worker.md`](./cloudflare-read-worker.md)) |
| Previous release retained | Public-store GC keeps ≥5 generations and ≥30 days; do not run `--apply`/`--apply-images` on the day of cutover |

## Cutover

```bash
export AIRINGCAL_BUILDER_SQLITE_PATH=/data/builder.sqlite
export AIRINGCAL_BUILDER_BACKUP_DIR=/data/backups

# 1. checkpoint backup (rollback anchor)
tsx apps/node-jobs/src/cli/portable-checkpoint-backup.ts

# 2. shadow gate must exit 0 (7 consecutive matches)
tsx apps/node-jobs/src/cli/portable-shadow-gate.ts \
  --sqlite "$AIRINGCAL_BUILDER_SQLITE_PATH" --legacy legacy.json --candidate public-snapshot.json

# 3. publish/refresh the v3 release (portable builder path, needs BGM_TOKEN + AIRINGCAL_USERS_JSON)
AIRINGCAL_BUILDER=portable AIRINGCAL_BUILDER_PUBLISH=true \
  tsx apps/node-jobs/src/cli/sync-main.ts

# 4. staging check of the Workers read gateway (manual, owner credentials)
wrangler deploy --config apps/v3-read-worker/wrangler.toml
curl -sf https://<staging-host>/api/health   # publish.generation must equal the published generation
```

Then confirm reads per [`web-worker-public-api.md`](../reference/web-worker-public-api.md)
contract (`/api/health`, `/api/collections`, `/api/calendar`, `/image/:hash`) and
start the observation window: run the shadow gate daily for **14 days** before
enabling legacy cleanup; any mismatch resets the streak to 0 and blocks further
cutover steps.

## Rollback (pointer CAS, C9)

Before production pointer rollback, freeze writes and confirm no in-flight run;
then CAS the pointer back to a chosen prior generation and record a receipt.

1. **Freeze the writer.** Set `AIRINGCAL_WRITER_ENABLED=false` (GitHub repo
   variable) so neither the schedule nor a manual dispatch can start a
   production writer run. Confirm the last GHA writer run has finished.
2. **Roll back the pointer.** The rollback CLI derives rollback candidates from
   the generation-scoped snapshot/manifest keys already in the store (no
   separate state service), takes the checkpoint lease to fence any in-flight
   writer (a held lease aborts the rollback), verifies every referenced image of
   the target generation, resolves its versioned manifest, and CAS-commits the
   pointer. Dry run by default; `--apply` requires the freeze attestation.

```bash
export AIRINGCAL_PUBLIC_S3_ENDPOINT=...   # staging/production public bucket
export AIRINGCAL_PUBLIC_S3_BUCKET=...
export AIRINGCAL_PUBLIC_S3_ACCESS_KEY_ID=...
export AIRINGCAL_PUBLIC_S3_SECRET_ACCESS_KEY=...
export AIRINGCAL_CHECKPOINT_S3_*=...      # enables the lease-based in-flight check
export AIRINGCAL_WRITER_ENABLED=false     # freeze attestation (matches the repo variable)

tsx apps/node-jobs/src/cli/portable-release-rollback.ts --generation <N>            # dry run
tsx apps/node-jobs/src/cli/portable-release-rollback.ts --generation <N> \
  --apply --writer-frozen --receipt rollback-receipt-<date>.json                    # CAS commit
```

The receipt records the **prior pointer**, the **target generation**
(`target_generation` / `target_artifact_ref` / `target_manifest_ref`), the image
gate result, the CAS outcome, and the resume rule. Attach it to #147.

`--receipt` is validated before any store or lease work: its parent directory must
exist, and the path is resolved to an absolute path. A missing directory fails with
`stage: receipt_preflight` and the pointer is untouched, so a typo cannot apply a
rollback while losing the audit record. A full image-gate pass over a large Release
(~1.35k hashes) takes a few minutes; the CLI verifies objects with the same bounded
concurrency as the publish gate.

3. **Resume rule (required before re-enabling the writer).** The builder SQLite
   checkpoint is independent of the public pointer: after a rollback the
   checkpoint may still hold a NEWER generation than the pointer. Before setting
   `AIRINGCAL_WRITER_ENABLED=true`, the owner must record how the checkpoint
   converges with the rolled-back Release:
   - **Restore/rebuild** the checkpoint to match the rolled-back generation
     (`portable-checkpoint-restore` from a backup, then verify), **or**
   - **Deliberately republish**: accept that the next writer run republishes the
     newer checkpoint state after review.
   Re-enable the writer only after that choice is recorded (receipt + #147).

If the Worker itself regressed (not the Release), re-deploy the previous Worker
version instead: `wrangler deployments list --name airing-cal-v3-read`.

**GC interaction:** public-store GC retains the current Release **and** its
rollback candidates — the `AIRINGCAL_GC_ROLLBACK_GENERATIONS` newest
generations strictly below the current pointer (default **2**), including the
images they reference. Do **not** run GC with `--apply`/`--apply-images` while a
rollback is in progress: the retained generations are the rollback targets.
Image GC fails closed when a retained snapshot cannot be parsed.

### Local drill (executed 2026-10-17, no production resources)

| Step | Command | Observed |
|---|---|---|
| Seed state | `portable-legacy-state-import … --subject-ids 501` | `{"status":"ok",…,"summary":{"imported":1,…},"cursor":{"last_subject_id":501,"batch_index":1}}` |
| Backup | `portable-checkpoint-backup` | `{"status":"succeeded","backupPath":"…/builder-checkpoint-2026-10-17T11-26-10.043Z.sqlite","pruned_delete_count":0}` |
| Divergence | `portable-legacy-state-import … --subject-ids 502` | `subject_media` rows `[501, 502]`, cursor `last_subject_id: 502` |
| Restore | `portable-checkpoint-restore.ts <backup> --force` | `{"status":"succeeded","stage":"checkpoint_restore",…}` |
| Verify | `SELECT subject_id FROM subject_media` + cursor row | rows `[501]`, cursor `last_subject_id: 501` (`subject_id 502` gone) |

The drill covers the checkpoint half of rollback (state restoration). The publish
and Worker-deploy steps require owner credentials and a real bucket/bgm.tv token,
so they are listed as commands above rather than claimed as executed.

## Open gaps before a production cutover

- Real v2 KV read against the production namespace by the owner (`portable-legacy-export`).
- D1/R2 export adapters are intentionally out of scope for the portable pipeline
  (R2 images stay in place; the subject set comes from the verified snapshot) —
  rationale in [`legacy-state-import.md`](./legacy-state-import.md#why-there-is-no-d1r2-export-adapter-decision-2026-10-17).
- Authenticated staging run of the Workers read gateway on a real bucket.
