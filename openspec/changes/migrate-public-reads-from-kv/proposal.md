## Why

D1/R2 核心落地后，公开读取仍依赖旧 KV snapshot 与逐 subject 状态，无法真正把 KV 降为发布指针。需要一个独立、可观测、可回滚的迁移阶段，把 legacy media metadata 导入 D1，验证 R2 shadow snapshot 与当前 API 等价，再安全切换 Read Worker 并渐进清理旧 key。

## What Changes

- 创建可恢复的 legacy KV metadata 迁移流程，每批最多处理 50 个 subject，并在 D1 保存游标与计数。
- 保持图片二进制 R2 key 不变，只迁移 detail/meta/image/refresh 元数据；重复运行不得覆盖更新的 D1 状态。
- 在旧 KV 继续服务期间生成并比较 R2 shadow snapshot，核对五类收藏、subject IDs、calendar、分页、图片和 NSFW 投影。
- 连续 7 次每日 shadow 一致且 KV 预算达标后，通过 `public:current` 切换 Read Worker 到 R2 `PublicSnapshotV1`。
- Read Worker 验证 pointer、schema、generation 与 hash；失败时使用最后已验证缓存，再回退旧 KV manifest。
- `/api/health` 从 D1 暴露 generation、预算与迁移摘要，同时保持现有字段兼容。
- 切换稳定 14 天后每天删除最多 50 至 100 个旧逐 subject KV key，并保留可回滚 R2 generation。

## Capabilities

### New Capabilities

- `legacy-state-migration`: 定义 resumable legacy KV metadata 导入、shadow 等价验证、切换门禁和渐进清理。

### Modified Capabilities

- `public-read-contracts`: 公开 API 改从已验证 R2 snapshot 读取并保持既有 JSON、分页和错误契约，异常时执行有界 fallback。
- `durable-sync-workflow`: 暴露迁移与 shadow 验证状态，并在切换后仅维护新发布链路。
- `cache-refresh-lifecycle`: 移除逐 subject KV 作为权威状态，保留兼容期只读 fallback 后渐进清理。
- `project-quality-gates`: 增加 7 次 shadow 一致门禁、回滚、迁移幂等和生产 KV 配额验收。

## Impact

影响 read-worker、sync migration Workflow、D1/R2/KV adapters、健康与缓存端点、迁移脚本、回滚 runbook 和测试。所有公开 URL 与响应 shape 保持兼容；本 change 不重新下载或复制现有图片，也不引入小时级同步或同日二次发布。
