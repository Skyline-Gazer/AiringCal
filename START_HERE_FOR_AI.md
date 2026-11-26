# START HERE FOR AI

**Prompt（中文）：** 先读 [`AGENTS.md`](AGENTS.md) 与 [`docs/README.md`](docs/README.md)。AiringCal `v3.0.0` 已收敛为唯一架构：**GitHub Actions 一次性 Portable Writer（`.github/workflows/portable-writer.yml`）→ 私有 Cloudflare R2 单桶（`airingcal-production` / `airingcal-development`，禁用 `r2.dev`）→ 无状态 Cloudflare Reader Worker（`apps/v3-read-worker`）**。安装、更新与恢复统一通过 `pnpm run setup`（或 `scripts/deploy-env.mjs`）执行。修改任何命令、环境变量或 API 前必须先查源码与 [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json)（`AGENTS.md` §零）。

**Prompt (EN):** Read [`AGENTS.md`](AGENTS.md) and [`docs/README.md`](docs/README.md) first. AiringCal `v3.0.0` is converged on a single supported topology: **GitHub Actions one-shot Portable Writer (`.github/workflows/portable-writer.yml`) → Private Cloudflare R2 single bucket (`airingcal-production` / `airingcal-development`, `r2.dev` disabled) → Stateless Cloudflare Reader Worker (`apps/v3-read-worker`)**. Installation, safe update, and recovery run through `pnpm run setup` (or `scripts/deploy-env.mjs`). Verify every CLI flag, config key, and API in source before writing (`AGENTS.md` §零).

## Mandatory Before Code or Operational Changes

1. **Verify Before Writing (`AGENTS.md` §零)**: Check `--help`, TypeScript definitions, and [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json).
2. **Respect Lifecycle Boundaries**: Never mutate live Production or Development infrastructure, rotate live tokens, or dispatch `portable-writer.yml` without explicit user authorization.
3. **Use Project Skills**: Follow [`.ads/STANDARD.md`](.ads/STANDARD.md), [`.ads/SAFETY.md`](.ads/SAFETY.md), [`.ads/QUALITY.md`](.ads/QUALITY.md), Ponytail Full-mode skills (`.agents/skills/ponytail*`), and Cloudflare Workers best practices (`.agents/skills/workers-best-practices`).

## Quick Map

| Need | Path |
| :--- | :--- |
| English Product Overview & Quick Start | [`README.md`](README.md) |
| Simplified Chinese Product Overview & Quick Start | [`README.zh-CN.md`](README.zh-CN.md) |
| Documentation Index | [`docs/README.md`](docs/README.md) |
| Deployment, Update & Recovery Guide (EN / ZH) | [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) / [`docs/DEPLOYMENT.zh-CN.md`](docs/DEPLOYMENT.zh-CN.md) |
| HTTP Read API & Widget Integration Guide (EN / ZH) | [`docs/API_AND_WIDGET.md`](docs/API_AND_WIDGET.md) / [`docs/API_AND_WIDGET.zh-CN.md`](docs/API_AND_WIDGET.zh-CN.md) |
| System Architecture & Security Model | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Portable Writer Operator Contract | [`apps/node-jobs/docs/operator-contract.md`](apps/node-jobs/docs/operator-contract.md) |
| Release Acceptance & Legacy Recoverability Evidence | [`docs/v3/release-acceptance-evidence.md`](docs/v3/release-acceptance-evidence.md) |
| Documentation & Commit Rules | [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md) |
