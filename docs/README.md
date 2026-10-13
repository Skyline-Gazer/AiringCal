# Docs index (for AI & operators)

## Production architecture (current)

| Layer | Runtime | Repo path |
| --- | --- | --- |
| **Read** | Cloudflare Worker `airing-cal-frontend` | `apps/web-worker` |
| **Write** | QingLong cron → `qinglong-bundle` | `apps/node-jobs` → artifact; wrappers in **QINGLONG-REPO** |
| **Not used** | sync/media Workers, VPS Postgres | `apps/*-worker` archived, `apps/vps-sync` abandoned |

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

## Plans (`docs/plans/`)

| File | Purpose |
| --- | --- |
| `phase-0-web-worker.md` | Single read Worker |
| `phase-1-node-jobs.md` | node-jobs + bundle |
| `no-cf-write-path.md` | AC-3-01 confirmation |
| `kv-binding-decision.md` | AC-3-03 — keep KV binding |
| `abandoned-vps-route.md` | Do not use VPS write |

## Runbooks (`docs/runbook/`)

| File | Purpose |
| --- | --- |
| `m2-read-surface.md` | Deploy web-worker, verify APIs/covers (**homelab M2 done 2026-10-13**) |
| `migrate-public-reads.md` | KV → R2 read-mode (optional ops) |

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
