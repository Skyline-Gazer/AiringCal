# Brainstorm Summary

- Change: migrate-data-plane-to-vps
- Date: 2026-08-28

## 已确认事实与约束

- VPS 只运行一次性 TypeScript 数据任务；公开请求仍由 Cloudflare Frontend/Read Worker 与 R2 承担。
- PostgreSQL 通过标准 `DATABASE_URL` 提供，供应商待部署时选择；数据库不进入 Compose。
- R2 使用 `public/manifest.json` 指向不可变、内容校验的 snapshot；公开请求不访问 VPS 或 PostgreSQL。
- 每轮任务在发布后执行 R2 数据库备份并发送飞书终态通知。
- 容器使用最新官方 `node:alpine`，production 最小化，debug 工具隔离到手动 target；GHCR production 使用完整 git SHA。
- VPS 首版人工拉取和部署，不由 GitHub Actions SSH 自动发布。
- 现有 `buildPublicSnapshot`、canonical hash、完整分页边界、shadow compare、R2 snapshot reader 与大量 failure-injection tests 可复用；Cloudflare D1/KV/Workflow/Queue/DO adapters 不进入新运行时。

## 候选技术方案

- 推荐：新增独立 `apps/vps-sync` composition root，领域逻辑继续位于共享 package；PostgreSQL repository、S3-compatible R2 adapter、backup、notification 分成独立端口与适配器。
- PostgreSQL schema 候选：规范化 `users + collection_items + subjects + subject_media + calendar + sync_runs + publications`，避免每个用户收藏行重复完整 subject JSON，适合托管 PostgreSQL 免费存储限制。
- 备选：直接移植当前 D1 row shape，迁移快但重复 JSON 且长期边界模糊。

## 待确认

- PostgreSQL 数据模型采用规范化模型，还是优先保持 D1 row shape 以减少首轮迁移工作。

## 测试策略候选

- 纯领域/协议单元测试继续使用 Node test runner。
- PostgreSQL adapter 使用临时真实 PostgreSQL integration tests，不用 SQL mock 代替 transaction/advisory-lock 语义。
- R2/飞书以端口 fake 做 failure injection，容器/GHCR 在 CI 做静态与运行时审计。

## Spec Patch 候选

- 设计阶段如锁定规范化 schema，只补充 provider-neutral/secret-free/完整事务场景的边界，不扩大已确认范围。
