# Docs index (for AI & operators)

> **Owner-confirmed (2026-11-05):** GitHub-only development; GHA one-shot Portable Builder is sole v3 writer target with private S3 checkpoint, one authoritative public S3 Release/images (R2 first); Cloudflare/EdgeOne stateless read, Netlify/Vercel later. **No CNB, QingLong or Docker/Compose deployment.** The writer implementation is merged into `dev` ([#146](https://github.com/Skyline-Gazer/AiringCal/pull/146), read parity [#148](https://github.com/Skyline-Gazer/AiringCal/pull/148), ops hardening [#149](https://github.com/Skyline-Gazer/AiringCal/pull/149)) but that does **not** mean production-live: real staging, API/image parity and owner cutover are tracked in [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147).
>
> **Reality check:** Existing v2 Worker read APIs still reference legacy D1/KV/R2 data; GHA Reader parity must pass before cutover. This feature PR gates Cloudflare Worker deployment / D1 migration to manual dispatch only.

## Approved v3 target architecture (not production-live)

| Layer | Runtime | Repo path |
| --- | --- | --- |
| **Read** | Cloudflare Worker `airing-cal-frontend` (multi-platform adapters follow) | `apps/web-worker` / `packages/v3-read` |
| **Write** | GitHub Actions one-shot portable builder → S3 (R2 day one) | `.github/workflows/portable-writer.yml`, `apps/node-jobs` |
| **Retired delivery targets** | QingLong writer, CNB runner, Docker/Compose (read and write), D1/KV as v3 write authority, VPS | historical docs / git history |

```text
Bangumi → GHA portable writer (node-jobs)
            → private R2 checkpoint (SQLite) + public R2 Release (+ images)
            → web-worker /api/* ; GET /image/:hash → 302 public CDN when AIRINGCAL_PUBLIC_BASE_URL set
```

Decision: [`plans/adr-0003-gha-portable-write.md`](plans/adr-0003-gha-portable-write.md).
Ops fill-in (placeholders until Secrets set): [`v3/gha-portable-writer.md`](v3/gha-portable-writer.md).

## Read order for agents

1. [`../START_HERE_FOR_AI.md`](../START_HERE_FOR_AI.md)
2. [`plans/phase-0-web-worker.md`](plans/phase-0-web-worker.md) — read Worker
3. [`plans/phase-1-node-jobs.md`](plans/phase-1-node-jobs.md) — write bundle (**Phase 1 closed**)
4. [`plans/no-cf-write-path.md`](plans/no-cf-write-path.md) — no CF Cron/Workflow write
5. [`apps/node-jobs/docs/operator-contract.md`](../apps/node-jobs/docs/operator-contract.md) — env, timeouts, exit codes
6. GHA writer ops: [`v3/gha-portable-writer.md`](v3/gha-portable-writer.md)

## v3 (in progress — parallel to v2 production)

v3 is being built on `dev` **without changing v2 production behaviour** until an
explicit owner-approved cutover. Tracking: [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67)
and [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7) (authoritative board).

| Doc | Purpose |
| --- | --- |
| [`v3/implementation-baseline.md`](v3/implementation-baseline.md) | Confirmed architecture, phases, delivery gates |
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
> CNB-primary model was not activated; see the
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
| `cnb-primary-migration.md` | GitHub-primary / CNB historical runbook (#139) |

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
