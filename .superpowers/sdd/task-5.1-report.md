# Task 5.1 Report — reader-delivery-bench harness (PR-A)

**Status:** FIXED (Important review findings)  
**Agent:** FixTask51Bench  
**Worktree:** `/home/ian/workspace/AiringCal/.worktrees/feat/reader-delivery-optimization`  
**Branch:** `feat/reader-delivery-optimization`  
**Prior commit:** `52ffa9b4` — `feat(bench): reader delivery baseline harness`  

## Summary

Shipped measurement-only harness `scripts/reader-delivery-bench.mjs` with companion `node:test` suite and a live Development baseline fixture at `docs/v3/fixtures/reader-delivery-bench-baseline.json`. No acceptance thresholds are enforced (`thresholds_enforced: false`). Widget vitals skipped honestly; mainland marked `pending_owner_node`.

## TDD evidence

### RED

Wrote `scripts/reader-delivery-bench.test.mjs` first (no harness module). Confirmed failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module .../scripts/reader-delivery-bench.mjs
nodes tests 1 / fail 1
```

### GREEN

Implemented exported helpers + `runBench` CLI. After nearest-rank `percentile` fix and import-test cleanup:

```text
node --test scripts/reader-delivery-bench.test.mjs
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Covered behaviors:
- median / p95 (nearest-rank) aggregation
- `--hosts` / `--out` / default hosts matching the plan
- publish identity + image hash extraction
- CDN HIT token recognition
- mainland `pending_owner_node` vs configured host
- widget `skipped_no_browser` (null LCP/CLS/INP — never fabricated)
- CF vs EO identity compare
- end-to-end `runBench` with mock fetch: named samples, `first_observed` when isolate recycle unavailable, honest host errors, fixture write, no threshold gating

### REFACTOR

Added 20s AbortController timeouts, skip unused response bodies on non-health paths, warm unbusted URL (no query-bust during CDN warm), HEAD-then-GET image CDN probe, parallel host runs. Unit suite stayed green.

## Deliverables

| Path | Role |
|---|---|
| `scripts/reader-delivery-bench.mjs` | CLI + exported pure helpers |
| `scripts/reader-delivery-bench.test.mjs` | TDD suite |
| `docs/v3/fixtures/reader-delivery-bench-baseline.json` | Live CF+EO baseline |

### CLI

```text
node scripts/reader-delivery-bench.mjs   --hosts https://airing-cal-v3-read-staging.r7a.workers.dev,https://test.air.teijp.cn   --out docs/v3/fixtures/reader-delivery-bench-baseline.json
```

Defaults match the plan when flags omitted. Optional `--runs N` (default 5).

### Protocol compliance

- Sample names: `first_after_deploy` / `repeat_same_isolate` / `cdn_shared_hit`
- When isolate recycle unavailable: `sample_label: first_observed`, `claims_cold_isolate: false` (never claim cold isolate from query bust alone)
- Each sample: median + p95 of N=5, plus raw `values_ms`, cache status / Age / identity when present
- Paths: `/api/health`, `/api/collections?type=watching&limit=24`, `/api/calendar`
- Image: discover hash from collections → `/image/<hash>` redirect + CDN Content-Type
- `cf_vs_eo` generation+content_hash equality
- `widget.status = skipped_no_browser`
- `mainland.status = pending_owner_node`
- `thresholds_enforced: false`

## Live baseline capture

Command exit summary:

```json
{"status":"ok","hosts":[{"host":"https://airing-cal-v3-read-staging.r7a.workers.dev","status":"ok"},{"host":"https://test.air.teijp.cn","status":"ok"}],"cf_vs_eo_equal":true,"mainland":"pending_owner_node","widget":"skipped_no_browser"}
```

Observed (raw; not gated):

- CF vs EO identity **equal** at generation `3` / content_hash `3869b256d4d7…`
- Both hosts image probe: **1× redirect**, CDN follow **200**, Content-Type currently `application/octet-stream` (expected pre-P0/P1 MIME work — recorded honestly)
- `cdn_shared_hit.warmed = false` on these hosts (platform cache headers did not show HIT during warm window; samples still recorded as `cdn_shared_attempted` under the `cdn_shared_hit` key)
- EO TTFB medians are multi-second from this agent network path; numbers are real measurements, not invented

## Concerns

1. **CDN HIT warm rarely observed** on current Development hosts (Worker responses often lack `CF-Cache-Status: HIT` / EO equivalent for these API routes). Harness records that honestly via `warmed: false` + `sample_label: cdn_shared_attempted`; Task 5.2 / post-P2 may need platform-specific cache-header mapping or longer warm.
2. **Image CDN Content-Type is `application/octet-stream`** in baseline — expected before MIME repair; do not treat as harness bug.
3. **Widget vitals not captured** (`skipped_no_browser`). Needs browser tooling in a later accept run.
4. **Mainland** remains `pending_owner_node` until `AIRINGCAL_BENCH_MAINLAND_HOST` is provided.
5. First live attempt without per-request timeouts timed out at 600s; fixed before successful capture. Keep timeouts.

## Out of scope (correctly omitted)

- Pass/fail threshold gating (Task 5.2)
- Writer/Release redesign, MIME publish fix, reader cache, widget UX, deploy-env

## Verification suggested for main agent

- `node --test scripts/reader-delivery-bench.test.mjs`
- Spot-check fixture: `docs/v3/fixtures/reader-delivery-bench-baseline.json` schema_version=1, both hosts `ok`, `thresholds_enforced=false`

## Important review fixes (Task 5.1 follow-up)

### Findings addressed

1. **`repeat_same_isolate` pairing** — `measurePathSamples` now runs per-trial `request A` then immediate `request B` on the **exact same URL** (same `bench_bust`), then warms CDN separately. No more batch-all-firsts → prime → batch-all-repeats.
2. **N=5 completeness** — successful samples are retried up to `runs * 3` with doubled timeout after the first `runs` attempts; hosts with any `n_ok < N` are marked `incomplete` (receipt `status` follows). CLI prints `receipt.status` instead of hardcoded `ok`.

### TDD evidence (pairing)

**RED** — added `measurePathSamples pairs first→second on the same URL per trial before CDN warm` before production change; failed with:

```text
AssertionError: trial 0 repeat must reuse the exact same URL as its paired first
+ actual:  .../api/health?bench_bust=...-1
- expected: .../api/health?bench_bust=...-0
```

**GREEN** — paired loop + incomplete host status. Suite:

```text
node --test scripts/reader-delivery-bench.test.mjs
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

Also added `runBench marks host incomplete when a sample stays below N after retries`.

### Baseline re-capture

Re-ran against plan hosts; first attempt CF `fetch failed` → honest `receipt.status=failed`; retry succeeded:

```json
{"status":"ok","hosts":[{"host":"https://airing-cal-v3-read-staging.r7a.workers.dev","status":"ok"},{"host":"https://test.air.teijp.cn","status":"ok"}],"cf_vs_eo_equal":true}
```

All samples `n_ok === 5` on both hosts (thin `n_ok=3` collections repeat from prior fixture eliminated).

### Remaining concerns

- CDN HIT still often unobserved (`cdn_shared_attempted`).
- Transient CF `fetch failed` can still happen; harness now refuses to claim `ok` when a host errors or samples are thin.
- Widget / mainland unchanged (`skipped_no_browser` / `pending_owner_node`).
