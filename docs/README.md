# AiringCal v3.0.0 — Documentation Index

[English](../README.md) | [简体中文](../README.zh-CN.md)

---

## 1. Product & Operator Guides

| Document | Language | Purpose |
| :--- | :--- | :--- |
| **[`../README.md`](../README.md)** | English | Product overview, screenshots, prerequisites, quick start (`pnpm run setup`), and AI-native setup prompt |
| **[`../README.zh-CN.md`](../README.zh-CN.md)** | 简体中文 | 中文产品总览、架构图、前置要求、快速安装/更新指南与 AI 原生复制指令 |
| **[`DEPLOYMENT.md`](DEPLOYMENT.md)** | English | Authoritative installation (`install`), existing-installation update (`update`), recovery (`recover`), headless CLI, live verification, and Writer gate operations |
| **[`DEPLOYMENT.zh-CN.md`](DEPLOYMENT.zh-CN.md)** | 简体中文 | 权威部署、安全更新、中断恢复、无头模式、线上验收与定时同步运维指南 |
| **[`API_AND_WIDGET.md`](API_AND_WIDGET.md)** | English | Read-only HTTP API reference (`/api/collections`, `/api/calendar`, `/api/health`, `/image/:hash`), public object routes, and blog Widget embedding |
| **[`API_AND_WIDGET.zh-CN.md`](API_AND_WIDGET.zh-CN.md)** | 简体中文 | 只读 HTTP API 参数说明、响应示例、缓存策略与个人博客 Widget 嵌入指南 |
| **[`ARCHITECTURE.md`](ARCHITECTURE.md)** | English | Write-plane CAS lease/checkpoint pipeline, read-plane snapshot verification cache, private-R2 isolation model, and monorepo package boundaries |
| **[`../CHANGELOG.md`](../CHANGELOG.md)** | English | Formal release changelog for `v3.0.0` |

---

## 2. Engineering Contracts & Governance Records

| Document | Purpose |
| :--- | :--- |
| **[`../apps/node-jobs/docs/operator-contract.md`](../apps/node-jobs/docs/operator-contract.md)** | Portable Writer CLI entrypoints, environment variables, timeouts, exit codes, media retry policy, and snapshot/image GC |
| **[`v3/release-acceptance-evidence.md`](v3/release-acceptance-evidence.md)** | Reconciled Production initialization receipt (`e5b3c98e` / run `45833583842`), legacy Git SHA recoverability record (Amendment D), and ADS `v0.8.0` consumer evidence (`#183`) |
| **[`rules/docs-sync.md`](rules/docs-sync.md)** | Rule §零 (Verify Before Writing), structured commit context requirements (§一), documentation sync (§二), and release audit checklist (§三) |
| **[`example/api/bgm-api.json`](example/api/bgm-api.json)** | Canonical Bangumi (`api.bgm.tv`) OpenAPI specification |
