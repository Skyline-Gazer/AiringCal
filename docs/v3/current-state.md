# AiringCal v3 — current state and operator handoff

> **Authoritative as of 2026-11-07.** Updated after PR [#164](https://github.com/Skyline-Gazer/AiringCal/pull/164) merged to `dev` at `a2c0cd67` and docs-governance PR [#165](https://github.com/Skyline-Gazer/AiringCal/pull/165) merged at `fc518131`. Project #7 Status and sub-issue hierarchy were read back via the API on 2026-11-07 (#67/#72/#147 In Progress, #71 Done, #73 Todo, #164/#165 Done; #67 parent of #69/#70/#71/#72/#73/#74/#147/#151), with no extra Status columns. Where older planning, issue text, or archived documents conflict, this document and the latest code/configuration on `dev` take precedence. **Do not confuse code merged, old staging proof, new Development cutover, and Production.**

## Delivery state

| Gate | Status | Evidence / next work |
| --- | --- | --- |
| Reader/MIME/Widget + deploy CLI engineering | **Delivered on `dev`** | [PR #164](https://github.com/Skyline-Gazer/AiringCal/pull/164); [CI 42354196599](https://github.com/Skyline-Gazer/AiringCal/actions/runs/42354196599) green (build:check, typecheck, test, operator smoke). |
| Old isolated **Staging** R2 (two buckets) | **Real-R2 acceptance PASS** | [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147): 3 generations, CAS/lease, image gate, rollback/GC, CF/EO reader parity. Preserve as rollback source. |
| New **Development** (one bucket) | **STAGING ACCEPTED** | `airingcal-development` + custom domain `airingcal.223.im` (SSL active, r2.dev off), host-scoped WAF/cache/CORS, anonymous checkpoint isolation proven (GET/HEAD 403), 2036 objects copied, `development` GH Environment synced, CF reader cut over, EdgeOne overseas project deployed, 302 routing verified, single writer test run `42397688191` success (generation 4), MIME repair 1352 objects, CF/EO parity + post-bench + accept green. Owner DNS cutover complete: reader domain **`airingcal.teijp.cn`** → overseas EO; old `test.air.teijp.cn` (global, gen 3) kept as rollback; final parity [`reader-delivery-cutover-parity-post.json`](./fixtures/reader-delivery-cutover-parity-post.json) `cf_vs_eo.equal: true`. See [`development-live-acceptance.md`](./development-live-acceptance.md). |
| Production Full Clean Deploy | **NOT AUTHORIZED** | [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) / [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7): board Status remains Todo/In Progress until Owner Apply evidence. In-repo SoT: this file + [`production-acceptance.md`](./production-acceptance.md); draft comment [`fixtures/issue-73-status-draft.md`](./fixtures/issue-73-status-draft.md); checklist fixture [`fixtures/production-acceptance-checklist.json`](./fixtures/production-acceptance-checklist.json). Acceptance = clean init → Bangumi Full Sync → one-shot v2 core-field diff → R2 CAS/image/MIME → CF/EO reader parity → CDN/WAF/cache → rollback/roll-forward drill → Owner GO/NO-GO → traffic switch. Mandatory 7 consecutive Shadow matches and 14-day observation retired. Production Apply not authorized; Writer remains disabled. |

## Architecture (approved target, not a claim of live cutover)

- **GitHub** is the single development origin (`dev` integration; `main` protected release). Project [#7](https://github.com/orgs/Skyline-Gazer/projects/7) and parent issue [#67](https://github.com/Skyline-Gazer/AiringCal/issues/67) track delivery. No CNB/QingLong/Docker deployment or Writer scheduler.
- **GitHub Actions** runs the sole one-shot Portable Writer. Release pointer, versioned manifest, immutable snapshot and original/WebP images live in **Cloudflare R2**. Every environment targets **one Bucket** (`airingcal-development`, later `airingcal-production`); object key prefixes `checkpoints/`, `public/`, `snapshots/`, `images/`.
- **Public R2 Custom Domain**, with CDN Cache and **host-scoped WAF**, serves `public/`, `snapshots/`, and `images/` directly. `checkpoints/` is internal and must be inaccessible via anonymous GET/HEAD on every public entrypoint. Disable the new Bucket's `r2.dev`. **CORS is not authentication or anti-hotlink access control.** No image gateway Worker and no on-request image compression.
- **Cloudflare and EdgeOne** are stateless Reader targets consuming one verified Release. EdgeOne Reader Makers project is `overseas` (unfiled domain); optional EdgeOne **image CDN** may use a separately filed domain and HTTPS R2 origin with correct Host/SNI; `AIRINGCAL_IMAGE_BASE_URL` defaults unset.
- Writer/Release CAS, fencing, single-authority rule, rollback contracts are unchanged. Snapshot cached per isolate (60-second soft pointer recheck); image route avoids full snapshot load; widget UX improvements are merged, **not** yet validated under new Development live deployment.

## Config and deployment gates

1. Do **GitHub Issue / PR / Project #7 reconciliation and documentation cleanup first**; check the state of [#67](https://github.com/Skyline-Gazer/AiringCal/issues/67), [#72](https://github.com/Skyline-Gazer/AiringCal/issues/72), [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73), and [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147). P2 engineering [#71](https://github.com/Skyline-Gazer/AiringCal/issues/71) is completed/closed. Avoid unnecessary new Issue/PR proliferation or Project Status columns.
2. Configure a **real R2 custom-domain URL in the same Cloudflare account's Zone** as the target Bucket. `AIRINGCAL_PUBLIC_BASE_URL` must not be blank, a placeholder or the old `r2.dev` URL. Derive or verify `AIRINGCAL_ZONE_ID` from zone ownership, never guess a Zone ID. Confirm EdgeOne Token/CLI authentication and legacy key mapping before modifying resources.
3. Use locally ignored `.env` based on [`.env.example`](../../.env.example): `AIRINGCAL_ENV=development`, `AIRINGCAL_DEPLOY_TARGET=both`, Cloudflare API Token, account ID (if needed), Zone ID, R2 public base, Bangumi identity, EdgeOne API Token. Cloudflare token can derive R2 S3 credentials **only after real S3 permissions verification**; no extra R2 keys on the normal happy path.
4. **Read-only preflight must pass before any Writer freeze:** domain availability/ownership, zone and token scopes, existing staging writer/workflows, R2 and EO CLI commands, target config, absence of conflicting public access.
5. After explicit Owner authorization, follow [reader-delivery-cutover.md](reader-delivery-cutover.md): freeze old staging writer, prepare `airingcal-development`, disable its `r2.dev`, apply host-scoped WAF/CORS/cache, verify a non-sensitive checkpoint probe is anonymous-denied, **then** copy real checkpoint/public data, sync GH Environment, deploy Reader, verify 302/parity, single Development Writer test with flag safely restored, apply MIME metadata repair and collect post-bench/CWV receipts. **Do not disable legacy staging rollback endpoints.**
6. Staging Accepted requires actual evidence: HEAD `image/*` for original/thumbnail; CF+EO generation/hash parity; meaningful cache/rollback metrics; LCP/CLS/INP measured when browser available; no fictitious CDN HIT or mainland results. Keep Production off.

## What is historical

- `staging` dual-bucket setup, `r2.dev` URL, and `scripts/setup-staging.sh` remain **legacy migration/rollback sources**, not the desired fresh Development bootstrap.
- Earlier ADRs and phase plans discussing CNB-primary, Docker/Compose, QingLong, fixed `public/manifest.json`, separate checkpoint/public production buckets or `dev` SHA snapshots are **historical**. Do not copy their commands into the new deployment procedure.
- This document is a compact current entrypoint, not a replacement for contracts or archived evidence: see [ADR 0001](adr-0001-release-contract-and-adapters.md), [GHA portable writer](gha-portable-writer.md), [EdgeOne read store](edgeone-store.md), [Production Acceptance](production-acceptance.md), and the [Production cutover/rollback runbook](cutover-rollback.md).

## Maintainer closeout checklist

- [x] PR #164 merged to `dev` with green main CI.
- [x] P2 #71 engineering and real staging proof reconciled as complete.
- [x] Project #7 native parent/sub-issue hierarchy, Status/Dates/Views read-back reconciled against current Issues; **no extra Status columns**.
- [x] Documentation governance PR reviewed and merged into `dev`; no newer contradictions in entrypoint/runbooks.
- [x] Read-only deploy preflight accepted; Owner confirms R2 hostname and Zone (`airingcal.223.im` / zone `223.im`).
- [x] Development Live Apply & WAF/CORS/Copy parity (2026-11-08, isolation.ok=true, 19/19 steps).
- [x] MIME repair and post-bench accepted (1352 repaired; `docs/v3/fixtures/reader-delivery-bench-post.json`; `reader-delivery-accept.mjs` exit 0).
- [x] EdgeOne overseas DNS cutover (`airingcal.teijp.cn` → overseas EO, Owner-executed) and post-CNAME parity (`cf_vs_eo.equal: true`).
- [ ] Separate future owner authorization for Production.
