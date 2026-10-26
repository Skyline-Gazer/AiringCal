# Docs index (for AI & operators)

## Production architecture (current)

| Layer | Runtime | Repo path |
| --- | --- | --- |
| **Read** | Cloudflare Worker `airing-cal-frontend` | `apps/web-worker` |
| **Write** | QingLong cron → `qinglong-bundle` | `apps/node-jobs` → artifact; wrappers in **QINGLONG-REPO** |
| **Removed from repo** | legacy Workers, VPS Postgres | pre-2026-10-15 `apps/*` — see git history / `docs/archive/` |

```text
Bangumi → node-jobs (bundle) ← QingLong
            → D1, R2 snapshot + image bucket, KV pointers
            → web-worker read APIs + /image/:hash
```

## Read order for agents

1. [`../START_HERE_FOR_AI.md`](../START_HERE_FOR_AI.md)
2. [`plans/phase-0-web-worker.md`](plans/phase-0-web-worker.md) — read Worker
3. [`plans/phase-1-node-jobs.md`](plans/phase-1-node-jobs.md) — write bundle (**Phase 1 closed**)
4. [`plans/no-cf-write-path.md`](plans/no-cf-write-path.md) — no CF Cron/Workflow write
5. [`apps/node-jobs/docs/operator-contract.md`](../apps/node-jobs/docs/operator-contract.md) — env, timeouts, exit codes
6. QingLong panel: [QINGLONG airingcal-operator-checklist](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/usage/airingcal-operator-checklist.md)

## v3 (in progress — parallel to v2 production)

v3 is being built on `dev` **without changing v2 production behaviour** until an
explicit owner-approved cutover. Tracking: [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67)
and [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7) (authoritative board).

| Doc | Purpose |
| --- | --- |
| [`v3/implementation-baseline.md`](v3/implementation-baseline.md) | Confirmed architecture, phases, delivery gates |
| [`v3/p0-contract-audit.md`](v3/p0-contract-audit.md) | v2 contract audit + CF/EdgeOne capability matrix (rows stay *candidate* until staging) |
| [`v3/p0-contract-evidence.md`](v3/p0-contract-evidence.md) | Evidence table: every implemented path with its test/CI guard |
| [`v3/portable-read-gateway.md`](v3/portable-read-gateway.md) | Filesystem read gateway + worker-safe subpaths |
| [`v3/cloudflare-read-worker.md`](v3/cloudflare-read-worker.md) | CF Workers entry, R2 binding/ETag contract, staging checklist |
| [`v3/edgeone-store.md`](v3/edgeone-store.md) | EdgeOne Blob store + read gateway, why not KV |
| [`v3/legacy-state-import.md`](v3/legacy-state-import.md) | #73 export → import pipeline (KV), D1/R2 scope decision |
| [`v3/shadow-gate.md`](v3/shadow-gate.md) | Seven-match shadow-equivalence gate |
| [`v3/cutover-rollback.md`](v3/cutover-rollback.md) | Owner-approved cutover/rollback runbook + executed drill |
| [`v3/airingcal-config.example.yaml`](v3/airingcal-config.example.yaml) | `airingcal.yaml` operator config (JSON twin alongside) |
| [`v3/CURSOR_HANDOFF.md`](v3/CURSOR_HANDOFF.md) | Historical handoff snapshot (2026-10-16) — verify live refs before relying on it |

Code entry points: `apps/v3-read-worker` (CF), `packages/v3-{core,builder,read,adapters}`,
`apps/node-jobs/src/cli/portable-*` (builder/scheduler/backup/gc/migration CLIs).

## Plans (`docs/plans/`)

| File | Purpose |
| --- | --- |
| `phase-0-web-worker.md` | Single read Worker |
| `phase-1-node-jobs.md` | node-jobs + bundle |
| `no-cf-write-path.md` | AC-3-01 confirmation |
| `kv-binding-decision.md` | AC-3-03 — keep KV binding |
| `abandoned-vps-route.md` | Do not use VPS write |
| `adr-0002-cnb-primary-migration.md` | CNB-primary source-of-truth + release mirror design (#139) |

## Runbooks (`docs/runbook/`)

| File | Purpose |
| --- | --- |
| `m2-read-surface.md` | Deploy web-worker, verify APIs/covers (**homelab M2 done 2026-10-13**) |
| `migrate-public-reads.md` | KV → R2 read-mode (optional ops) |
| `cnb-primary-migration.md` | CNB-primary cutover state, daily flow, rollback (#139) |

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
