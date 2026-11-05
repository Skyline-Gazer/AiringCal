# START HERE FOR AI

**Prompt（中文）：** 先读 [`docs/README.md`](docs/README.md) 和 [`AGENTS.md`](AGENTS.md)。v3 最终目标：GitHub 为唯一开发主仓库；GitHub Actions 执行一次性 Portable Builder，私有 S3 Checkpoint + 共享公开 S3 Release（初期 R2）；Cloudflare/EdgeOne 负责读取，后续增加 Netlify/Vercel。不使用 CNB、青龙或 Docker/Compose。**PR #146 未合并、生产未切换**；当前追踪见 Issue #67/#147 和 Project #7。修改前确认当前代码/生产事实与目标架构的区别。

**Prompt (EN):** Read `docs/README.md` and `AGENTS.md` first. Approved v3 target: GitHub-only development, GHA one-shot Portable Builder, private S3 checkpoint plus one public S3 Release (R2 first), stateless CF/EdgeOne readers followed by Netlify/Vercel. CNB, QingLong, and Docker/Compose are retired. **PR #146 is unmerged and no production cutover is approved.** See Issues #67/#147 and Project #7.

## Mandatory before code changes

1. Verify CLI flags, env keys, and APIs in source — do not guess (`AGENTS.md` §零).
2. **Target** production writer = GHA Portable Builder (PR #146; gated by #147), not QingLong/CNB/Docker; **actual `dev` still has legacy read/write code**. No Cloudflare Worker Cron/Workflow writes.
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
