# AiringCal v3 implementation baseline

> **Accepted target, 2026-11-05 (merged, not yet cut over):** GitHub-only development; GitHub Actions scheduled/manual one-shot Portable Builder is the **sole v3 writer**, using ephemeral SQLite and **private S3-compatible durable checkpoint**. One authoritative **public immutable Release/images** on S3-compatible object storage (initially Cloudflare R2) is consumed by stateless Cloudflare/EdgeOne read adapters, followed by Netlify/Vercel. **No QingLong, CNB, Docker or Compose runtime/deployment or CI acceptance** in v3. The writer implementation is merged into `dev` ([PR #146](https://github.com/Skyline-Gazer/AiringCal/pull/146), read parity #148, ops hardening #149); staging acceptance and cutover are tracked in [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147). Legacy v2 read API / D1-KV-R2 paths remain the default until `AIRINGCAL_READ_MODE=v3-release` is enabled; do not claim production cutover.

Status: Working implementation baseline; governed by [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67) and [Skyline-Gazer Project #7](https://github.com/orgs/Skyline-Gazer/projects/7).

## Authoritative workflow

- `dev` is the integration base. As of 2026-10-31, `origin/dev` is `c9ea158169632b5b51684b6d97d929b4fe675878` (merge of #143, 2026-10-27 17:24 +0800) and `origin/main` is `a4b3b082d15943e11a2d5443077f9ab5f3c175dc` (2026-10-15 19:17 +0800). `main` is an ancestor of `dev` and is 166 commits behind (`git rev-list --count origin/main..origin/dev`). The 2026-10-16 “aligned” sentence is obsolete. Do not fast-forward `main` from a documentation pass. Preserve `archive/main-before-v3-alignment-20261016` (`d10d3c9b6d6ab7b2505b3f8fc01074f1741d2da2`).
- Work on dedicated feature branches, reviewable PRs targeting `dev`, and child Issues of #67. No direct production modification or deployment during architecture/bootstrap.
- Initial development branch `feat/v3.0.0` starts at `3.0.0-alpha.0`; avoid broad implementation commits inside the bootstrap PR. Existing v2 production workflow must not be triggered by feature-branch pushes.
- GitHub Project #7 is the authoritative task board, projects #5/#6 retired by owner. Project item/status operations must be independently verified.
- Alibaba OpenCodeReview is the selected AI reviewer, advisory initially; see #74.

## Product boundaries

- One instance represents exactly one Bangumi user. No multi-tenancy, login or user switching.
- Preserve current frontend appearance/features and public behavior. Refactor internals, not the product.
- Initial platform priority: Cloudflare and Tencent EdgeOne. Later adapters ship through incremental versions after verified platform-specific support.
- Core is portable: thin platform adapters, shared domain/Builder/Release contract, same published assets across platforms. Do not copy Xget runtime/infra blindly; Xget is a request-proxy, AiringCal is an offline builder plus static reader.

## Runtime and state

- **ADR 0003 (PR #146)** implements GHA Writer and S3-compatible stores, with manual-only Cloudflare deployment and a scheduler activation gate. R2 staging, reader parity, and owner cutover remain pending #147. Docker/Compose deployment files, scripts and CI are retired.

- **GitHub Actions-only write runner**: one-shot Portable Builder; local SQLite/WAL during the run, restored from a private S3-compatible durable checkpoint and saved conditionally on success. Prevent two authoritative writers publishing one site; cross-runner lease/CAS/fencing and recovery must pass isolated real-R2 staging (#147).
- **No Docker/Compose deployment or scheduler target**. Remove related build/test/DoD only after retaining portable Builder and HTTP reader contract coverage. CNB and QingLong are historical, not supported delivery platforms.
- Daily incremental sync and seven-day full reconciliation by default; manual sync supported. Failed core collections/calendar completeness halts publishing; previously verified subject details/images may be reused with explicit stale/partial status.
- Credential-bearing private checkpoint and published public store are separate. All published content is explicitly public allowlisted data.

## Publication and frontend

- Immutable content-addressed images and versioned Release, pointer updated only after complete verification. Require safe single-publisher coordination supported by chosen backend; otherwise fail closed.
- Default original + 320x427 WebP quality 78 thumbnail. Future image variants versioned; GC must be reference-aware, dry-run first, keep >=30d and >=5 successful releases and manual pins.
- Decide single JSON snapshot versus a few modules from measured real v2 payload and frontend read contract, **not** speculative overengineering. Readers pin a version to avoid mixing releases.
- `airingcal.yaml` with validated schema + environment/platform secret source, `airingcal setup` interactive and noninteractive. Never implicitly create billable services.

## Explicit delivery gates

1. [#69](https://github.com/Skyline-Gazer/AiringCal/issues/69) Audit real v2 read/sync behavior and Cloudflare/EdgeOne feature matrix.
2. [#70](https://github.com/Skyline-Gazer/AiringCal/issues/70) Portable Builder and SQLite.
3. [#71](https://github.com/Skyline-Gazer/AiringCal/issues/71) Release, images, frontend parity.
4. [#72](https://github.com/Skyline-Gazer/AiringCal/issues/72) CF/EdgeOne adapters, setup.
5. [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) Read-only migration, backup/restore, rollback, E2E smoke and owner-approved cutover.
6. [#74](https://github.com/Skyline-Gazer/AiringCal/issues/74) Advisory OpenCodeReview.

Do not mark a gate complete without evidence in Issue/PR and checked CI. No production cutover via merge side effects.

## Advisory reviewer status (2026-10-17)

The Alibaba OpenCodeReview workflow (`.github/workflows/ocr-review.yml`) is
**disabled** (`disabled_manually`).

- **Root cause** (read from the uploaded run artifact `ocr-result.json` /
  `ocr-stderr.log`): the grouping LLM call failed with **HTTP 402 Payment
  Required** — the OpenRouter account behind `OCR_LLM_AUTH_TOKEN` has exhausted
  its credit balance ("you can only afford 14970 of 16384 tokens"). This is a
  billing/credential problem, not a code or config bug. The `OCR_EXIT_CODE: 1`
  seen on every failing run is just the Action exiting non-zero after that API
  error; docs/test-only PRs were merely skipped ("no items selected").
- **To re-enable**: add credit to the OpenRouter account backing
  `OCR_LLM_AUTH_TOKEN`, then `gh workflow enable 386430913`, then
  `gh workflow run ocr-review.yml` on a real (code) PR and confirm the job posts
  comments instead of failing. The workflow is now non-blocking
  (`continue-on-error: true`), so a reviewer outage will never turn an
  otherwise-fine PR red.
- Until then, PR review is owner/manual and each PR records its own verification
  evidence.
- Re-checked 2026-10-31 with `gh workflow list --repo Skyline-Gazer/AiringCal --all`:
  workflow id `386430913` is still `disabled_manually`. This pass does not
  re-enable it.

## Historical progress reconciliation (2026-10-31; superseded by #67/#147 2026-11-05 decisions)

GitHub Project #7 remains the named board in #67 and in #69–#73. This token
cannot read it: `gh project list --owner Skyline-Gazer` returned no projects,
and `organization.projectsV2` returned an empty node list. No Project column
was read or written. The last column snapshot still on record is the
2026-10-17 comment on #67 (#74 Done; #69–#73 In Progress). Issue bodies were
not edited.

`openspec/changes` contains only `archive/`. No active Comet change.

| Issue | State | On `dev` | Still open | Issue-body drift |
| --- | --- | --- | --- | --- |
| #67 | OPEN | Parent tracker | Child gates below | — |
| #69 | OPEN | Audit, ADR 0001, sizing run [39052596856](https://github.com/Skyline-Gazer/AiringCal/actions/runs/39052596856) (generation 15, gzip 110 769 B, `single_json_viable: true`) | Cloudflare real-bucket CAS and EdgeOne Blob staging; matrix rows stay candidate | — |
| #70 | OPEN | Portable builder, SQLite, scheduler, Compose E2E | 2026-10-25 note: SQLite lease is not distributed fencing (#135). OCR still disabled | Remaining text still says the sizing CLI has not been run |
| #71 | OPEN | Release, GC, thumbs, parity, portable/Compose E2E; sync tab removed (#128) | Frontend E2E left manual; real v3 publisher/CAS unverified. 2026-10-25 note records a fixed-key `public/manifest.json` across generations; this pass did not re-audit that code | Sizing line on the issue is already marked completed |
| #72 | OPEN | CF R2 store, v3-read-worker local smoke, EdgeOne Blob fail-closed, `airingcal.yaml` / setup | Real staging on both platforms | — |
| #73 | OPEN | KV export/import, shadow gate, cutover runbook, local rollback drill | Owner-run production KV export, owner cutover, 14-day observation. D1/R2 export adapters are explicitly not outstanding | Remaining text still lists anonymized sizing as open; #69 records it done |
| #74 | CLOSED | OCR workflow exists and is disabled | Billing/credential, not code | — |
| #133 #135 #136 #138 #139 | OPEN | Related CNB / runtime notes | Not closed here. ADR 0002 amendment (2026-10-27) already records GitHub as the write origin; #139’s body is still the pre-amendment plan | — |
| #134 #137 | CLOSED | — | — | — |

Do not close #69–#73 from this reconciliation. Owner-gated staging, export, and cutover are still open. Do not merge `dev` into `main`.

### Branch hygiene (executed with this reconciliation)

Merged topic branches whose tips are ancestors of `origin/dev` (history stays reachable from `dev`):

| Branch | Tip | PRs | Action |
| --- | --- | --- | --- |
| `chore/convergence-2026-10-27` | `4aa55fde1c28b059b31a5d77c3d0c806426c8ea7` | #143 merged | deleted from `origin` 2026-10-31; tip still in `dev` |
| `feat/adopt-ads-v0.4.2` | `06704330555adc08e09e64cfd808c092d4ae3962` | #142 merged | deleted from `origin` 2026-10-31; tip still in `dev` |
| `m0/migration-runbook` | `d49466f5e5a682c86dadcb92444ddd7fd8f82c1e` | #140 and #141 merged | deleted from `origin` 2026-10-31; tip still in `dev` |

Kept, because they are not ancestors of `dev` or they are the integration/production refs:

| Branch | Tip | Why kept |
| --- | --- | --- |
| `main` | `a4b3b082d15943e11a2d5443077f9ab5f3c175dc` | Production ref. Ancestor of `dev`, 166 commits behind. Not a topic branch. |
| `dev` | `c9ea158169632b5b51684b6d97d929b4fe675878` | Integration base. |
| `archive/main-before-v3-alignment-20261016` | `d10d3c9b6d6ab7b2505b3f8fc01074f1741d2da2` | 3 commits not in `dev`. Baseline says preserve. |
| `chore/cnb-sync-pilot` | `0672f85633b828e4f49a47de45ca960c1d747dae` | 8 commits not in `dev`. ADR 0002 says preserve on both platforms. |
| `docs/development-freeze-snapshot` | `97e6a28211989af4bdccfcd29f10c656506cdad9` | One commit (2026-09-03 +0800) not in `dev`: obsolete freeze note at SHA `6c522f09`. Do not merge. Do not delete without another copy of that commit. |
| `cursor/cloud-agent-env-306e` | `98d73a100a8f723c15cbe81c81f36cca7de5c458` | Open PR #144. |

Actions registration that is not a branch: workflow `360816866` (“Publish VPS sync production image”) is still `active`, and `GET /repos/Skyline-Gazer/AiringCal/contents/.github/workflows/vps-sync-image.yml?ref=dev` returns 404. The file is on `archive/main-before-v3-alignment-20261016`. This pass does not disable the registration. See [`../plans/abandoned-vps-route.md`](../plans/abandoned-vps-route.md).
