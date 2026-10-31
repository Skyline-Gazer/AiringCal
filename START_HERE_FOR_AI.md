# START HERE FOR AI

**Prompt（中文）：** 先读 [`docs/README.md`](docs/README.md) 了解 monorepo 结构、生产读/写路径；ADR 0003 写侧为 GitHub Actions portable→S3（[`docs/v3/gha-portable-writer.md`](docs/v3/gha-portable-writer.md)）。v3 跟踪见 Issue #67 / Project #7。改代码前读 [`AGENTS.md`](AGENTS.md) 与 [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)。青龙写路径已退役，勿把业务逻辑塞进 QINGLONG-REPO。

**Prompt (EN):** Read `docs/README.md` first. Production write = GitHub Actions portable writer (ADR 0003 / `docs/v3/gha-portable-writer.md`). Follow `AGENTS.md`. QingLong is retired as the write scheduler.

## Mandatory before code changes

1. Verify CLI flags, env keys, and APIs in source — do not guess (`AGENTS.md` §零).
2. Production write path is **QingLong + node-jobs**, not Workers Cron/Workflow (`docs/plans/no-cf-write-path.md`).
3. Commit docs with code; run `pnpm test` / relevant package tests before done.

## Quick map

| Need | Path |
| --- | --- |
| AI doc index | `docs/README.md` |
| **v3 work (in progress)** | [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67) + [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7); docs under `docs/v3/` (index in `docs/README.md`) |
| Phase 1 (node-jobs) | `docs/plans/phase-1-node-jobs.md` |
| D1 apply order | `apps/node-jobs/docs/d1-schema.md` |
| Env / exit codes (canonical) | `apps/node-jobs/docs/operator-contract.md` |
| Read surface deploy (M2) | `docs/runbook/m2-read-surface.md` |
| Historical / abandoned | `docs/archive/README.md` |
