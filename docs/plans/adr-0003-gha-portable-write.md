# ADR 0003 — GitHub Actions write path, portable→S3, public image URLs

- Status: **Accepted (decision 2026-10-31, Asia/Shanghai)**. Implementation
  **landed in-repo** (workflow + portable bundle + S3 checkpoint/public stores +
  image CDN redirect + QingLong/Compose scheduler/`qinglong-bundle` retired);
  **not production-live** until Secrets are filled and a successful
  `workflow_dispatch` is observed. See [`../v3/gha-portable-writer.md`](../v3/gha-portable-writer.md).
- Parent: [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67),
  Project #7.
- Relates: #69–#73 (v3 gates), #133 / #135 / #136 (CNB write execution — superseded
  as production write plane), #139 / ADR 0002 (GitHub write-origin for *source*;
  this ADR is about *data-plane write scheduling*).
- Supersedes (as **target** production write model, once implemented):
  QingLong + `qinglong-bundle` as the live writer; CNB cron/manual as a production
  write execution plane; Docker/Compose long-running write scheduler as a delivery
  target; Cloudflare D1/KV as the v3 write data plane.
- Does **not** supersede: ADR 0001 release contract / `PublicStore` port; GitHub
  as git write origin (ADR 0002 amendment 2026-10-27).

## Context

AiringCal splits into **write** (offline sync → immutable public Release) and
**read** (serve widget + `/api/*` + images). Owner decisions on 2026-10-31:

- QingLong is already stalled and will be **replaced**, not run in parallel.
- v3 portable Builder already exists; Compose/Docker and CNB were discussed as
  schedulers and are no longer desired for production write.
- Read must eventually run on Cloudflare, Tencent EdgeOne, Netlify, and Vercel
  against the **same** published assets. Image loads through the current Worker
  proxy are too slow; originals must remain callable by the owner.

## Decision

### W1 — Sole write scheduler: GitHub Actions

| Item | Choice |
| --- | --- |
| Trigger | `schedule` daily at **04:00 `Asia/Shanghai`**, plus `workflow_dispatch` |
| Shape | **One** workflow; each run is a **one-shot** process (exit when done) |
| Mode | Inside the run, choose `incremental` or `full` from durable checkpoint state: if days since last **successful full** ≥ 7 → `full`, else `incremental`. Do **not** use a calendar `*/7` cron for full |
| Concurrency | One in-flight writer (`concurrency` group); do **not** cancel an in-progress run |
| Entry | Thin shell + existing Node portable entry (built artifact / `pnpm` invoke). **No** native binary requirement |
| Secrets | GitHub Actions Secrets / Variables → env |
| Alert | Failure notification via **Bark**; success stays quiet by default (optional weekly digest later) |

Git source of truth remains GitHub `dev` (ADR 0002 amendment). This ADR adds
**data-plane** scheduling on GitHub Actions; it does not revive CNB as write origin.

### W2 — Checkpoint: SQLite working set + private object store

| Item | Choice |
| --- | --- |
| Working state | Local **SQLite** for the duration of the Actions run (reuse `@airing-cal/v3-builder`) |
| Durable store | **Private** object bucket (day one: **Cloudflare R2** S3 API) |
| Protocol | Restore checkpoint → sync → on success upload checkpoint; no WAL stored as the durable form |
| Fencing | Single-writer lease / conditional put on the checkpoint (or lease) object; lost lease → fail closed + Bark |
| Not chosen now | Cloudflare D1 or Neon Postgres as the **authoritative** checkpoint |

### W3 — Publish: S3-compatible `PublicStore` (R2 day one)

| Item | Choice |
| --- | --- |
| Contract | ADR 0001 release layout; pointer CAS / conditional write or **fail closed** |
| Day-one backend | Cloudflare **R2** for the **public** Release bucket (snapshots, images, pointer) |
| Abstraction | Configured S3 endpoint / region / bucket / keys — R2 is one backend, not a hard-coded product API |
| Backlog | Verify at least one **non-R2** S3-compatible backend (TODO; not day-one gate) |
| Non-S3 | EdgeOne Blob / filesystem remain separate adapters; do not pretend they are S3 |

Private checkpoint bucket and public Release bucket stay **separate** (credentials
and lifecycle independent), even if both are R2 on day one.

### W4 — Retire QingLong, D1/KV write, Docker write, CNB write plane

When implementation lands (tracked work, not this ADR merge alone):

| Retired | Disposition |
| --- | --- |
| QingLong as production writer | Abandoned; no parallel cutover required (owner: already stalled) |
| Cloudflare **D1 / KV write** path for v3 | Abandoned; portable → S3 only (“travel light”) |
| Docker / Compose **write** scheduler and related delivery target | **Remove code**; docs → historical |
| CNB as production **write execution** (#135-class) | Yields to GHA; CNB may remain historical / optional non-prod evidence only |
| `qinglong-bundle` as the named production contract | Replace with the GHA one-shot portable entry; rename/docs as needed |

Read Worker must continue to **not** gain Cron/Workflow write triggers
(`docs/plans/no-cf-write-path.md` intent remains: no CF write path).

### R1 — Images: public object URLs; edge only serves API (+ stable image routes)

| Item | Choice |
| --- | --- |
| Bytes | Serve image bytes from the **public** bucket / CDN (R2 public/custom domain or CDN in front). Do **not** keep Worker/edge as the steady-state byte proxy |
| List UI | Prefer pre-published `thumb.v2.webp`; publish path must materialize thumbs offline; no on-request transform on the read path |
| Platforms | Same Release consumed by CF / EdgeOne / Netlify / Vercel thin read adapters (read multi-platform remains a parallel track; does not block write cutover) |

### R2 — Keep owner-callable original image API

Already implemented and **retained** as a public contract:

| Route | Meaning |
| --- | --- |
| `GET /image/:hash` | **Original** bytes (`images/{hash}/original`) |
| `GET /image/:hash/thumb` | Pre-materialized thumb (`thumb.v2.webp`, fallback v1) |

Implementation may change to **redirect** to the public CDN/S3 URL or to emit
absolute URLs in JSON, but the stable routes (or documented absolute equivalents
derived from the same hashes) remain so the owner can fetch originals without a
Bearer token. `POST /api/thumb-gen` is **not** part of the long-term public read
contract (internal/legacy write assist).

## Consequences

- Production docs that still describe QingLong → D1/R2/KV as the live writer are
  **stale relative to this decision** until the implementation PR updates them.
  Until then, treat this ADR as the target; do not claim GHA already writes.
- #70 “No QingLong in new runtime” aligns; Compose scheduler ceases to be a
  production write deliverable.
- #135 CNB write execution is not the production path; re-scope or close that
  slice when Project #7 is updated by someone with project write access.
- #73 cutover language that assumes QingLong/v2 writer continuity must be
  rewritten against portable→S3 + GHA when implementation starts.
- Multi-S3 verification and Netlify/Vercel adapters stay explicit TODOs.

## Non-goals (this decision)

- Enabling paid Cloudflare / S3 / Actions capacity beyond current free/owner use
- Implementing Netlify/Vercel adapters in the same change as the first GHA writer
- Native compiled binary distribution
- Making D1 or Neon the checkpoint authority
- Fast-forwarding `main` or production Worker deploy as a side effect of merging
  this ADR

## Suggested tracking issue (owner may paste)

Title: `v3 / ADR 0003: GHA portable writer + public image URLs`

Body sketch:

```text
Parent: #67. Decision: docs/plans/adr-0003-gha-portable-write.md

## Scope
1. GHA workflow 04:00 Asia/Shanghai; one-shot portable sync; checkpoint mode.
2. Private R2 checkpoint + public R2 Release (S3 API); separate buckets.
3. Remove QingLong/D1-KV write/Docker write scheduler/CNB write-plane from
   delivery; docs → historical; delete retired write code.
4. Public image CDN/direct URLs; keep GET /image/:hash (original) and /thumb.
5. Bark on failure. Secrets via Actions env.

## Out of scope / TODO
- Non-R2 S3 backend verification
- Netlify/Vercel read adapters
- Closing #135 production write claims (project column + issue text)

## DoD
- Scheduled run green against staging buckets
- Docs index + operator contract match GHA writer
- No QingLong / D1-KV write / Compose write scheduler left as current truth
- Image original still fetchable by hash without Bearer
```

## Verification (decision record only)

- Owner answers recorded in agent session 2026-10-31 (Asia/Shanghai): direct
  QingLong replace; GHA not CNB; day-one private checkpoint + S3 on R2; abandon
  D1/KV write; remove Docker/CNB write code (docs historical); 04:00 Shanghai
  self-judged full/incremental; public image bytes; retain `/image/:hash`.
- No production workflow or bucket change accompanies this documentation PR.

## Amendment — Production Full Clean Deploy (2026-11-08)

- Production uses one new bucket `airingcal-production` (prefixes), never a clone/copy of Development/Staging/v2 buckets.
- Production bootstrap creates independent `.env.production`, CF token/zone/custom domain, Reader Worker, EdgeOne overseas project, GitHub `production` Environment, fresh SQLite checkpoint/lease/release.
- First Production Release comes from Bangumi Full Sync; scoped v2 migration only for fields proven non-rebuildable.
- Mandatory 7 consecutive Shadow matches and 14-day observation are retired as Production hard gates.
- New acceptance: clean init → Bangumi Full Sync → one-shot v2 core-field diff → R2 CAS/image/MIME → CF/EO reader parity → CDN/WAF/cache → rollback/roll-forward drill → Owner GO/NO-GO → traffic switch.
- This amendment does not authorize Production Apply, `main` cutover, or enabling `AIRINGCAL_WRITER_ENABLED`.
