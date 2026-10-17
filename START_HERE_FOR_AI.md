# START HERE FOR AI

**Prompt（中文）：** 先读 [`docs/README.md`](docs/README.md) 了解 monorepo 结构、生产读/写路径、部署与 D1/R2/KV；v3 工作（并行、未 cutover）见 [`docs/README.md` 的 v3 段](docs/README.md#v3-in-progress--parallel-to-v2-production) 与 Issue #67 / Project #7。改代码前读 [`AGENTS.md`](AGENTS.md) 与 [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)。写路径在 `apps/node-jobs` + 青龙 [QINGLONG-REPO](https://github.com/Skyline-Gazer/QINGLONG-REPO) 薄脚本；勿把业务逻辑复制进青龙库。

**Prompt (EN):** Read `docs/README.md` first for layout and production architecture; v3 work (parallel, not cut over) is indexed in its [v3 section](docs/README.md#v3-in-progress--parallel-to-v2-production) plus Issue #67 / Project #7. Follow `AGENTS.md` before edits. Write path = `apps/node-jobs` → CI `qinglong-bundle` → QingLong wrappers only.

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
