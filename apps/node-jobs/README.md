# @airing-cal/node-jobs

Scheduled **sync** and **backup** for the D1 + R2 data plane (Route A). QingLong runs the bundled scripts from `dist/qinglong-bundle/`; logic lives here, not in QINGLONG-REPO.

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build    # dist/qinglong-bundle/*.mjs
```

## Layout

| Path | Role |
|------|------|
| `src/sync/run.ts` | Sync orchestration (fetch → media → publish) |
| `src/sync/media-refresh.ts` | Download Bangumi covers into `AIRING_CAL_IMAGE_BUCKET` and upsert D1 `subject_media` |
| `src/backup/run.ts` | D1 export → private R2 |
| `src/adapters/` | D1 HTTP client, job lease, R2 store, env validation |
| `schema.sql` | D1 additions for job lease/state (apply before first run) |
| `scripts/build-qinglong-bundle.mjs` | esbuild entries for QingLong |

Phase 1 **closed** — [`docs/plans/phase-1-node-jobs.md`](../../docs/plans/phase-1-node-jobs.md). Operator: [`docs/d1-schema.md`](docs/d1-schema.md), [`docs/operator-contract.md`](docs/operator-contract.md).

## Media

Sync downloads `lain.bgm.tv` / `lain.bangumi.tv` covers from the collection and calendar payloads, stores `images/{sha256}/original` in the image bucket, and upserts `subject_media`. The public snapshot then carries `images.*.{hash,uri,r2_key}` and `image_status: cached`.

`GET /image/:hash` on web-worker reads `airing-cal-images`, not the snapshot bucket. Set `AIRING_CAL_IMAGE_BUCKET=airing-cal-images` and use an R2 token that can write that bucket. Snapshot publication stays on `AIRING_CAL_R2_BUCKET`.

A sync whose image map changes the snapshot hash publishes `generation + 1` (`nextSnapshotGeneration`). The first run after this bundle should log `media selected=` greater than 0. Downloads stop when less than 30 seconds remain before the run deadline, so the snapshot can still publish; the next run continues the rest. A later run skips rows whose source URL is unchanged and `next_refresh_at` is still in the future; that skip is `selected=0` with images already in the snapshot. Re-running the previous noop bundle cannot fill images.

`apps/media-worker` is archived and is not this path.
