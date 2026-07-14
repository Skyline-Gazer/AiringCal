## Why

当前定时同步把长时间业务刷新绑在 Worker Queue 与 CI/CD 部署之后，收藏分页、subject detail、metadata 和图片刷新会在同一轮集中执行，容易超过执行预算并留下永久 `running` 状态。需要在 Cloudflare Free Plan 限额内引入可恢复、可观测的 Workflow 编排，将快照发布与重型媒体刷新解耦，并让部署流程只负责交付代码和验证控制面。

## What Changes

- 新增 Cloudflare Workflow，同步收藏与 calendar、发布 shadow/live 快照、规划异步刷新任务，并持久化每次运行的阶段、心跳和结果。
- 将 subject detail、metadata、图片与 R2 刷新保留在 Media Queue，增加确定性任务 ID、去重状态和 stale-while-revalidate 生命周期。
- 将自动部署与业务同步解耦：CI/CD 不再触发 full sync 或轮询 KV，只部署并检查 Worker、Workflow 与绑定；Free Plan Worker Cron 在 shadow 验证后只负责创建 Workflow instance。
- 为 bgm.tv GET 请求增加有界超时与有限重试，限制账号同步和公开 cache API 的请求规模，避免无界分页、重复拉取和 token 泄漏。
- 增加 Workflow、Media Queue、账号同步、健康状态与 CI 配置的回归测试和发版验证流程。
- **BREAKING** 手动业务同步不再通过部署后的 trigger queue 自动发生；运维改为显式创建 Workflow instance，旧 trigger queue 在稳定观察期后移除。

## Capabilities

### New Capabilities

- `durable-sync-workflow`: 定义 Free Plan 下可恢复、幂等、支持 shadow/live 的收藏与 calendar 同步编排、状态和运维行为。
- `cache-refresh-lifecycle`: 定义 subject detail、metadata、图片缓存的 stale-while-revalidate、刷新任务去重、重试和终态语义。

### Modified Capabilities

- `sync-consistency`: 将完整快照提交、失败保留旧快照、互斥执行和账号同步输入约束扩展到 Workflow 与 compare/apply 流程。
- `project-quality-gates`: 要求部署与业务同步解耦、Workflow 控制面可验证，并把 Workflow/Queue/缓存边界纳入自动检查与文档审计。

## Impact

- Worker：`apps/sync-worker`、`apps/media-worker`、`apps/read-worker`、`apps/frontend-worker`。
- 共享包：bgm.tv client、缓存 key/schema、Queue job、运行状态和错误处理类型。
- Cloudflare 资源：Workflows、KV、R2、Media Queue、旧 sync trigger Queue 与 Cron schedule。
- API：`/api/health`、`/api/cache`、`/api/sync/compare`、`/api/sync/apply` 的响应、分页和输入约束。
- 交付：GitHub Actions、Wrangler 配置、bootstrap/运维脚本、README 和部署文档。
