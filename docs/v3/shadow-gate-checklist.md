# Shadow-gate checklist (v3 Production cutover pre-condition, #73)

Owner-approved gate: the v3 Release may only go live after the shadow gate
shows **7 consecutive daily matches** between the legacy read surface and the
v3 candidate Release. Any mismatch resets the streak to 0.

> **OWNER_ACTION:** execution of every item below waits on the owner's
> staging credential export (isolated staging R2 checkpoint + public bucket +
> staging Environment secrets). No CI or agent process performs these steps.

## Preconditions

- [ ] Isolated staging credentials exported (never production secrets):
      `AIRINGCAL_CHECKPOINT_S3_*`, `AIRINGCAL_PUBLIC_S3_*`, `BGM_TOKEN`,
      `AIRINGCAL_USERS_JSON` pointing at staging buckets
- [ ] `AIRINGCAL_WRITER_ENABLED` stays `false` (unset) on GitHub until this checklist passes
- [ ] Fresh checkpoint backup exists (`portable-checkpoint-backup`)

## Daily shadow runs (repeat until 7 consecutive matches)

- [ ] Run portable builder against staging (`AIRINGCAL_BUILDER=portable AIRINGCAL_BUILDER_PUBLISH=true tsx apps/node-jobs/src/cli/sync-main.ts`)
- [ ] Run the shadow gate:
      `tsx apps/node-jobs/src/cli/portable-shadow-gate.ts --sqlite <path> --legacy legacy.json --candidate public-snapshot.json` → exit **0**
- [ ] Record match/miss in #147; any miss resets the streak and blocks cutover
- [ ] Two distinct Release generations exist (manifests + snapshots + pointer) before declaring the gate satisfied
- [ ] Pointer CAS / 412 conflict behavior observed on the real bucket
      (note: MinIO CI PASS is compatibility-only, **not** a real-R2 PASS)
- [ ] Checkpoint restore after a clean run verified
- [ ] Image completeness for the current pointer: all referenced originals/required thumbs readable
- [ ] Reader (web-worker `AIRINGCAL_READ_MODE=v3-release` and/or v3-read-worker) serves the latest Release API/images consistently

## Gate exit

- [ ] 7 consecutive daily matches recorded on #147
- [ ] Owner signs off on cutover per [`cutover-rollback.md`](./cutover-rollback.md)
