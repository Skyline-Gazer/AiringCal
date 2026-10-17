# Shadow equivalence gate (#73)

Compares the normalized legacy export with the currently published snapshot,
persists the consecutive-match streak, and reports whether a cutover is
permitted. Read-only with respect to the published release: the only write is
the streak record in the builder SQLite `builder_kv`.

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-shadow-gate.ts \
  --sqlite /data/builder.sqlite \
  --legacy <legacy.json> --candidate <public-snapshot.json> \
  [--hydrated <sidecar.json>] [--reset]
```

| Flag | Meaning |
|---|---|
| `--sqlite` | Builder SQLite checkpoint holding `migrate:shadow:streak` |
| `--legacy` | v2 R2 snapshot JSON **or** legacy public result JSON (no `schema_version`) |
| `--candidate` | Current published `PublicSnapshotV1` JSON |
| `--hydrated` | Optional legacy hydration sidecar (`{ "<subject_id>": {...} }`) |
| `--reset` | Clear the streak and exit |

## Behaviour

- Both sides go through the same normalization (`normalizeV2PublicExport`), then
  `compareShadowSnapshots` reports business differences (collection fields,
  subject ids, calendar, summary, images, NSFW).
- Equal run → streak +1, `last_success_at` updated. Mismatch → streak reset to
  `0`, up to 20 diffs stored in `last_diff_summary`, and the run exits **2**.
- A corrupt/absent streak record is ignored: counting restarts from 0 instead of
  trusting the stored value.
- Cutover permitted only when the streak reaches **7** consecutive matches
  (`cutover_allowed`).
- Run it once per day (scheduler/cron); the streak is the operator-visible
  evidence trail for the #73 gate.

Exit codes: `0` gate open, `2` gate closed (equal or diff), `1` usage/IO error.

## Not covered here

- **KV budget acceptance** is a v2-specific condition (legacy per-subject KV
  writes); the portable path performs no legacy KV writes, so there is nothing to
  budget in this slice.
- The cutover itself (publishing a v3 release, switching reads) and the 14-day
  observation gate remain owner-approved manual steps.
