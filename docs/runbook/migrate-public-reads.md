# migrate-public-reads runbook

> 对应 OpenSpec change：`migrate-public-reads-from-kv`。技术设计见
> `docs/superpowers/specs/2026-07-31-migrate-public-reads-from-kv-design.md`。

> **历史 runbook，当前 VPS data-plane 切换已取代此流程。** 当前 Read Worker 直接读取
> `public/manifest.json`；`public:read-mode` 与 `public:current` 不再控制公开 snapshot 来源。
> 当前部署和回滚请遵循 [`vps-data-plane.md`](vps-data-plane.md)。下文仅保留旧 D1/KV
> 迁移流程的历史记录，不要据此执行当前切流或清理。

## 目标状态

公开读取从 legacy KV manifest 切换到验证过的 R2 `PublicSnapshotV1`，legacy
逐 subject key 在 14 天观察期后以每天最多 100 个 key 的速度清理；D1 是媒体与
同步权威状态，永不回滚 D1 行。

## 状态与门禁

- `public:read-mode`（KV 镜像）与 `migrate:read-mode`（D1 权威）：
  `legacy` 或 `r2`。
- `migrate:shadow:streak`：连续 7 次每日 legacy↔R2 规范化等价比较成功后
  达到 7；任何业务差异归零。
- `migrate:kv-budget-daily:{date}`：每日 legacy 逐 subject KV 写计数；
  连续 7 日 ≤100 才放行切换。
- 切换动作：`promoteShadowPointer` 把 `public:shadow-current` 提升为
  `public:current`，随后 `switchReadMode` 写 D1 权威并镜像 KV。

## 切换（cutover）

1. 确认 `/api/health` 的 `migration.shadow_streak >= 7` 且
   `migration.kv_budget_ok = true`。
2. 确认 `snapshot.source = legacy` 且公开 API（`/api/collections`、
   `/api/calendar`、图片）正常。
3. 触发每日 Workflow（或等下一次 20:00 UTC cron）；门禁通过后 workflow 自动
   提升 pointer 并切换 read-mode。
4. 切换后验证：`/api/health` 的 `snapshot.source = r2` 且 `generation` 与
   R2 对象一致；`/api/collections`、`/api/calendar` 与图片继续 200 且 shape
   不变。

## 回滚（rollback）

- 任何阶段都可回滚：把 `migrate:read-mode` 与 `public:read-mode` 写回
  `legacy`（`rollbackReadMode`），公开读取立即回到旧 KV manifest。
- 回滚不删除、不改写 R2 对象与 generation，也不回滚 D1 行。
- 回滚后清理 runner 自动停止（只读模式不清理）。
- 再次切换需重新满足连续 7 次 shadow 一致与预算门禁。

## 清理（cleanup）

- 仅在 `read-mode=r2` 且切换满 14 天后运行；每天最多删除 100 个 legacy
  逐 subject key，按 subject 升序推进 `migrate:cleanup:cursor`。
- 删除前必须确认 `public:current` 有效且目标 R2 generation 可读；任一条件
  不满足当天零删除。
- 单 subject 删除失败时游标停在失败前一个 subject，下次续跑。
- 清理启用后回滚能力依赖保留的 R2 generation 与 `public:current`，不再依赖
  已删 legacy key。

## 停止与恢复

- 停止：把 read-mode 写回 `legacy`（见回滚）；清理与 shadow 比较自动暂停。
- 恢复：确认资源与预算后重新跑每日 Workflow，从已持久化游标继续迁移与
  清理，不重复导入/删除已完成项。

## 故障排查

- 公开 API 异常：先看 `/api/health` 的 `degraded` 与 `snapshot.source`；
  R2 不可用时 read-worker 自动走 Cache API 最后验证版 → legacy KV fallback。
- streak 被重置：查看 `migrate:shadow:streak.last_diff_summary`，定位业务
  差异字段；仅时间/排序噪声不会重置。
- KV 预算超限：检查 `migrate:kv-budget-daily` 与 live workflow 的每日
  逐 subject 写计数；超限日不会放行切换。
