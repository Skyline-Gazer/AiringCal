# Development Live Acceptance — evidence (2026-11-08)

**Scope:** Development only. Production was not touched; production Writer remains disabled.
**Authoritative entry:** [`current-state.md`](./current-state.md). Runbook: [`reader-delivery-cutover.md`](./reader-delivery-cutover.md).

## Apply (`deploy-env --apply --target both`, round 21)

`status: applied`, `ok: true`, `abortCutover: false`, `dualBucketFallback: false`, `developmentWriterEnabled: false`, 19/19 steps completed.

| Gate | Evidence |
| --- | --- |
| Single bucket | `airingcal-development`; `checkpoints/**`, `public/**`, `snapshots/**`, `images/**` key prefixes |
| Public domain | `https://airingcal.223.im` custom domain `ssl/ownership: active`; `r2.dev` disabled |
| Isolation | anonymous `GET`/`HEAD` of `https://airingcal.223.im/checkpoints/_isolation-probe.txt` → **403 / 403** (`isolation.ok: true`) before any data copy |
| Zone rules | WAF `block` on `(http.host eq "airingcal.223.im" and starts_with(path, "/checkpoints/"))`; cache rules for `/images/`+`/snapshots/` 1y immutable and `/public/current-release.json` bypass; CORS `GET,HEAD` exact origins |
| Copy | 2036 staging objects (public 4, snapshots 3, images 2029, checkpoints 3 incl. real SQLite + lease) copied with size+etag skip |
| GH | `development` Environment with 9 variables / 3 secrets; `AIRINGCAL_DEVELOPMENT_USERS_JSON` derived from staging Environment |
| Readers | CF worker `airing-cal-v3-read-staging` cut over; EdgeOne overseas `airingcal-edgeone-read-overseas` deployed with bundled runtime env; both `/api/health` 200 |
| Image routing | both readers `GET /image/7d617149…` → 302 `Location: https://airingcal.223.im/images/…/original` (`originMatches: true`) |
| Single writer | GHA run [42397688191](https://github.com/Skyline-Gazer/AiringCal/actions/runs/42397688191): run + development job `success`, `restored: true`; workflow `disabled_manually`, repo gate `false`; new generation **4** published |

## MIME repair (`portable-image-mime-repair`)

Dry-run: 1355 originals scanned, 1353 `would_fix`, 2 `ok`, 0 unknown/conflict.
Apply (`--concurrency 16`): **1352 repaired, 3 ok, 0 conflict/verify_failed/error**, `complete: true`; body sha256 unchanged per-object verification; public CDN HEAD samples all `image/jpeg` (e.g. `7d617149…/original`).

## Parity, benchmark, acceptance

| Item | Result |
| --- | --- |
| CF↔EO identity | both `generation: 4`, `content_hash: 2613eb5d9a6308c9e4b380937e15e42aa0972768d61f358f1831e80541f16670` |
| Post bench | [`fixtures/reader-delivery-bench-post.json`](./fixtures/reader-delivery-bench-post.json): `status: ok`, `cf_vs_eo.equal: true`, both hosts `image/jpeg` + 302 + CDN 200; `mainland.status: pending_owner_node` (not fabricated) |
| Accept | `node scripts/reader-delivery-accept.mjs --skip-cf-smoke --post … --public-base https://airingcal.223.im --image-hash … --rollback-generation 3` → **exit 0**, 4 measurable gates pass (baseline, post_bench, portable_e2e `checks:9`, live MIME HEAD), `failed_gates: []` |
| Rollback safety | `portable-release-rollback --generation 3` dry-run receipt: `dry_run: true`, `cas_result: not_attempted`, image gate `reused: 2028`; pointer untouched, writer frozen |
| Freeze | `portable-writer.yml` `disabled_manually`, 0 in-progress runs; `AIRINGCAL_WRITER_ENABLED` false (Production gate) |

Pending (not claimed): `test.air.teijp.cn` CNAME → overseas EO + post-CNAME parity (Owner DNS), mainland bench, optional ICP image CDN, CF smoke (skipped in accept run), shadow-gate RO status, and all Production apply/cutover.

Machine-readable checklist: [`fixtures/reader-delivery-cutover-checklist.json`](./fixtures/reader-delivery-cutover-checklist.json).
