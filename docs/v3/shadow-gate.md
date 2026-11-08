# Production parity tool — one-shot shadow compare (#73)

Compares a normalized legacy / v2 export with a candidate `PublicSnapshotV1`
and reports equal/diff in one shot. This is the **data-integrity tool** for
Production Acceptance gate 5 in [`production-acceptance.md`](./production-acceptance.md).
It does **not** persist a match streak, expose `cutover_allowed`, or open traffic.

```bash
pnpm exec tsx apps/node-jobs/src/cli/portable-shadow-gate.ts \
  --sqlite /data/builder.sqlite \
  --legacy <legacy.json> --candidate <public-snapshot.json> \
  [--hydrated <sidecar.json>] [--reset]
```

| Flag | Meaning |
|---|---|
| `--sqlite` | Builder SQLite path (required; used for optional leftover-key cleanup with `--reset`) |
| `--legacy` | v2 R2 snapshot JSON **or** legacy public result JSON (no `schema_version`) |
| `--candidate` | Current / candidate `PublicSnapshotV1` JSON |
| `--hydrated` | Optional legacy hydration sidecar (`{ "<subject_id>": {...} }`) |
| `--reset` | Delete any leftover `migrate:shadow:streak` key and exit (cleanup only; no counters rewritten) |

## Behaviour

- Both sides go through the same normalization (`normalizeV2PublicExport`), then
  `compareShadowSnapshots` reports business differences (collection fields,
  subject ids, calendar, summary, images, NSFW).
- Equal → stdout JSON `stage: shadow_gate_equal`, `equal: true`, `diff_count: 0`, exit **0**.
- Mismatch → `stage: shadow_gate_mismatch`, `equal: false`, up to 20 diffs, exit **2**.
- Usage / IO errors → exit **1**.
- No streak mutation on compare. Historical streak keys may be cleared with `--reset`.

Pure file compare without sqlite: `portable-snapshot-compare.ts <left.json> <right.json>` (exit 2 on diff).
Normalize first with `portable-v2-public-normalize.ts` when inputs are raw v2/legacy shapes.

## Not covered here

- **KV budget acceptance** is a v2-specific condition; the portable path performs no legacy KV writes.
- Traffic switch, Writer enablement, and resource Apply are Owner gates in [`production-acceptance.md`](./production-acceptance.md) / [`cutover-rollback.md`](./cutover-rollback.md).
- Legacy KV cleanup after cutover is Owner-flagged (`--owner-approved`), not a day timer — see cleanup section in the acceptance doc.

## Historical decision

An earlier design required **7 consecutive** daily matches (`cutover_allowed`) before cutover. That streak hard gate is retired; Production uses one-shot equal/diff plus the full acceptance checklist.
