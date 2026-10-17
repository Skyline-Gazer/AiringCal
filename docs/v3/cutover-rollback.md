# Cutover and rollback runbook (#73)

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

## Rollback

Checkpoint state is the authoritative v3 side; the public store is
content-addressed, so rolling back is two steps: restore the checkpoint, then
re-publish so the release pointer moves back to the restored generation
(`publishBuilderCheckpoint` is a no-op if the pointer already matches).

```bash
export AIRINGCAL_BUILDER_SQLITE_PATH=/data/builder.sqlite
export AIRINGCAL_BUILDER_BACKUP_DIR=/data/backups

# 1. restore the pre-cutover checkpoint (overwrites the target SQLite)
tsx apps/node-jobs/src/cli/portable-checkpoint-restore.ts \
  "$AIRINGCAL_BUILDER_BACKUP_DIR/builder-checkpoint-<timestamp>.sqlite" --force

# 2. re-publish so the release pointer matches the restored state
AIRINGCAL_BUILDER=portable AIRINGCAL_BUILDER_PUBLISH=true \
  tsx apps/node-jobs/src/cli/sync-main.ts

# 3. if the Worker itself regressed, re-deploy the previous Worker version
wrangler deployments list --name airing-cal-v3-read
```

Do **not** run public-store GC with `--apply`/`--apply-images` while a rollback is
in progress: the retained generations are the rollback targets.

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
- D1/R2 read-only export adapters (KV metadata is the only exported legacy source today).
- Authenticated staging run of the Workers read gateway on a real bucket.
