# Brainstorm Summary

- Change: migrate-public-reads-from-kv
- Date: 2026-07-31

## 确认的技术方案

用户确认继续第三点（对应 OpenSpec design.md 既有设计）；技术方案按
`docs/superpowers/specs/2026-07-31-migrate-public-reads-from-kv-design.md`：

1. resumable legacy 导入（≤50/批、app_state 游标、幂等、复用 R2 key）；
2. 每日 shadow 规范化比较（五类/calendar/summary/图片/NSFW，剔除运行时字段），
   连续 7 次一致 + KV 写预算达标才允许切换；
3. 迁移期 shadow pointer 写入 `public:shadow-current`，门禁通过后提升为
   `public:current` 并置 `public:read-mode=r2`；
4. read-worker 验证 pointer/schema/hash 后读 R2，fallback 顺序为
   Cache API 最后验证版 → legacy KV manifest；
5. 切换 14 天后每日 ≤100 key 限速清理，保留至少一个已验证 R2 generation。

## 关键取舍与风险

- 无新 D1 表/migration SQL；复用 subject_media、app_state、sync_budget。
- 每日 cron 同时运行 live legacy 发布（保证公开新鲜）与 D1 shadow 阶段。
- 风险：legacy 不完整（媒体轮转补全）、比较排序噪声（规范化）、R2 不可用
  （双 fallback）、清理后回滚（14 天观察 + 保留 generation）、KV 预算口径
  （Worker 内每日计数 + 生产验收观测）。

## 测试策略

TDD 五组：迁移（中断续跑/幂等/缺 key/R2 PUT 零）；shadow（规范化/streak
重置/仅时间差异）；读切换（pointer 校验/两级 fallback/API 契约）；门禁与
回滚；清理（14 天零删/≤100 key/保留 generation）。全仓 test/typecheck/
build:check/strict OpenSpec/diff check 为退出门禁。

## Spec Patch

无。现有 5 个 delta spec 已覆盖验收场景；实现中发现缺口按小规模增量回写并注明。
