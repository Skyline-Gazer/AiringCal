# Docs index (for AI & operators)

> **CURRENT — 2026-11-07.** Read [v3/current-state.md](v3/current-state.md) **first**. PR [#164](https://github.com/Skyline-Gazer/AiringCal/pull/164) merged at `a2c0cd67` with green CI. **Old dual-bucket Staging real-R2 proof PASSED** (three generations/CAS/rollback), while **new one-bucket Development Live Acceptance has NOT been performed**. Production remains v2 and is NOT approved for cutover. See [#67](https://github.com/Skyline-Gazer/AiringCal/issues/67) / [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147) / [#72](https://github.com/Skyline-Gazer/AiringCal/issues/72) / [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73).
>
> **Approved:** GitHub-only `dev` → `main` release, one-shot GHA Writer, Cloudflare R2 single Bucket **per environment**, direct public Release/images on R2 Custom Domain with host-scoped WAF denying `checkpoints/`. Cloudflare/EdgeOne are stateless readers; EdgeOne Reader `overseas`, optional separate ICP image CDN off by default. **No CNB, QingLong, Docker/Compose deployment.** `CORS` does not protect private objects. `r2.dev` must be disabled for the new mixed bucket, after checking rollback boundaries.

## Approved v3 target architecture (not production-live)

| Layer | Runtime | Repo path |
| --- | --- | --- |
| **Write** | One-shot GitHub Actions Portable Writer; Production schedule OFF | `.github/workflows/portable-writer.yml`, `apps/node-jobs` |
| **Storage** | Cloudflare R2: `airingcal-development` target (later `airingcal-production`); one bucket with public and denied checkpoint prefixes | `scripts/deploy-env*.mjs`, `packages/storage` |
| **Read** | Cloudflare Worker + EdgeOne Makers overseas, same verified Release and independently optional image CDN | `packages/v3-read`, `apps/v3-read-worker`, `apps/edgeone-read-worker` |
| **Retired / historical** | QingLong, CNB, Docker/Compose, v2 D1/KV as v3 write authority | Historical plans / archive |

```text
Bangumi → GHA Portable Writer
        → R2 one Bucket per env:
           checkpoints/ (blocked over public domain)
           public/ + snapshots/ + images/ (CDN-served)
        → CF Reader / EdgeOne Overseas Reader → optional ICP image CDN for images
```

**Acceptance sequence:** Issue/PR/Project #7 + docs governance → read-only Zone/domain/token preflight → Owner-approved Development live apply → MIME repair + CF/EO parity + post-benchmark → separate future production decision. Contracts: [ADR 0003](plans/adr-0003-gha-portable-write.md); [GHA ops](v3/gha-portable-writer.md).

## Read order for agents

1. **[`v3/current-state.md`](v3/current-state.md) — authoritative status, gates, deployment architecture**
2. [`../START_HERE_FOR_AI.md`](../START_HERE_FOR_AI.md)
3. [`plans/phase-0-web-worker.md`](plans/phase-0-web-worker.md) — read Worker
4. [`plans/phase-1-node-jobs.md`](plans/phase-1-node-jobs.md) — write bundle (**Phase 1 closed**)
5. [`plans/no-cf-write-path.md`](plans/no-cf-write-path.md) — no CF Cron/Workflow write
6. [`apps/node-jobs/docs/operator-contract.md`](../apps/node-jobs/docs/operator-contract.md) — env, timeouts, exit codes
7. GHA writer ops: [`v3/gha-portable-writer.md`](v3/gha-portable-writer.md)

## v3 (in progress — parallel to v2 production)

v3 is being built on `dev` **without changing v2 production behaviour** until an
explicit owner-approved cutover. Tracking: [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67)
and [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7) (authoritative board).

| Doc | Purpose |
| --- | --- |
| **[`v3/current-state.md`](v3/current-state.md)** | **Current authoritative architecture, engineering vs live acceptance, operator handoff** |
| [`v3/implementation-baseline.md`](v3/implementation-baseline.md) | Historical implementation baseline; current status supersedes stale 2026-10 SHA/phase text |
| [`v3/gha-portable-writer.md`](v3/gha-portable-writer.md) | ADR 0003 GHA writer ops + Secrets fill-in list |
| [`v3/p0-contract-audit.md`](v3/p0-contract-audit.md) | v2 contract audit + CF/EdgeOne capability matrix (rows stay *candidate* until staging) |
| [`v3/p0-contract-evidence.md`](v3/p0-contract-evidence.md) | Evidence table: every implemented path with its test/CI guard |
| [`v3/portable-read-gateway.md`](v3/portable-read-gateway.md) | Filesystem read gateway + worker-safe subpaths |
| [`v3/cloudflare-read-worker.md`](v3/cloudflare-read-worker.md) | CF Workers entry, R2 binding/ETag contract, staging checklist |
| [`v3/edgeone-store.md`](v3/edgeone-store.md) | EdgeOne Blob store + read gateway, why not KV |
| [`v3/legacy-state-import.md`](v3/legacy-state-import.md) | #73 export → import pipeline (KV), D1/R2 scope decision |
| [`v3/shadow-gate.md`](v3/shadow-gate.md) | Seven-match shadow-equivalence gate |
| [`v3/cutover-rollback.md`](v3/cutover-rollback.md) | Owner-approved cutover/rollback runbook + executed drill |
| [`v3/reader-delivery-cutover.md`](v3/reader-delivery-cutover.md) | PR-D reader-domain cutover runbook (parity → CNAME → r2.dev) + Owner-pending checklist hook |
| [`v3/airingcal-config.example.yaml`](v3/airingcal-config.example.yaml) | `airingcal.yaml` operator config (JSON twin alongside) |
| [`v3/CURSOR_HANDOFF.md`](v3/CURSOR_HANDOFF.md) | Historical handoff snapshot (2026-10-16) — verify live refs before relying on it |

Code entry points: `apps/web-worker` (CF read), `packages/v3-{core,builder,read,adapters}`,
`apps/node-jobs/src/cli/gha-portable-writer*.ts` + `portable-*` (backup/gc/migration CLIs).

## Plans (`docs/plans/`)

> **Git write origin: GitHub** (`Skyline-Gazer/AiringCal`, `dev`). ADR 0002’s
> CNB-primary model is superseded and must not be used; see the
> [2026-10-27 amendment](plans/adr-0002-cnb-primary-migration.md#amendment-2026-10-27-github-primary).
> **Data-plane write:** [ADR 0003](plans/adr-0003-gha-portable-write.md)
> (GHA portable→S3; **implemented in repo**; not production-live until Secrets +
> successful `workflow_dispatch`). Open PRs against `dev`.

| File | Purpose |
| --- | --- |
| `phase-0-web-worker.md` | Single read Worker |
| `phase-1-node-jobs.md` | node-jobs + bundle (Phase 1 closed; artifact renamed to `portable-bundle`) |
| `no-cf-write-path.md` | AC-3-01 confirmation |
| `kv-binding-decision.md` | AC-3-03 — keep KV binding |
| `abandoned-vps-route.md` | Do not use VPS write |
| `adr-0002-cnb-primary-migration.md` | CNB-primary design, superseded in part by the 2026-10-27 GitHub-primary amendment (#139) |
| `adr-0003-gha-portable-write.md` | Accepted 2026-10-31: GHA portable→S3 writer, public images, retire QingLong/D1-KV/Docker/CNB write (implemented and merged into `dev` via #146/#148/#149; staging/production cutover pending) |

## Runbooks (`docs/runbook/`)

| File | Purpose |
| --- | --- |
| `m2-read-surface.md` | Deploy web-worker, verify APIs/covers (**homelab M2 done 2026-10-13**) |
| `migrate-public-reads.md` | KV → R2 read-mode (optional ops) |
| `cnb-primary-migration.md` | **Archived history only** — CNB not approved for current delivery |

Homelab closure (QingLong): [QINGLONG governance](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/governance/2026-10-13-homelab-closure.md)

## Archive

[`archive/README.md`](archive/README.md) — `superpowers/`, `job-transfer/`, old VPS docs (**not production**).

## Packages (code truth)

| Path | Role |
| --- | --- |
| `apps/web-worker` | Public HTTP |
| `apps/node-jobs` | Sync/backup pipelines, `schema.sql` |
| `packages/storage` | Snapshot types, read-mode |
| `migrations/` | D1 authoritative schema (apply before node-jobs) |
