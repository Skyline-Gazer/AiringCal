---
comet_change: migrate-public-reads-from-kv
role: task-12-verification-ready
status: local-evidence-ready-pending-independent-review-and-production
verified_scope: full-local-gates-migration-shadow-read-cutover-cleanup
verified_source_sha: f763f8e
---

# migrate-public-reads-from-kv verification-ready evidence

本文记录本地门禁证据；运行时 SHA `f763f8e`（`feat(sync): run daily shadow
migration and gate in scheduled workflow`）。未做远程迁移、merge、部署与生产
观测；OpenSpec 6.1/6.2 生产验收项 pending。

## Fresh local gates

| Command | Result | Exact evidence |
|---|---|---|
| `CI=true pnpm test` | PASS | 全仓测试通过（storage 新增 legacy 导入/比较；sync 新增 migration runner、streak/门禁、daily-shadow、scheduled 接线、清理、回滚；read-worker 新增 R2 加载与 health；worker-common 契约更新） |
| `pnpm typecheck` | PASS | 9 个 workspace 全过 |
| `pnpm build:check` | PASS | 4 个 Worker dry-run 通过（read/sync 现使用 D1/data-R2 binding） |
| `./node_modules/.bin/openspec validate migrate-public-reads-from-kv --strict` | PASS | Change 有效 |
| `git diff --check` | PASS | 无输出 |

## Implemented units（TDD，逐个 RED→GREEN 提交）

1. `packages/storage/src/legacy-migration-types.ts` — 迁移/shadow/read-mode/
   清理 typed app_state values 与 key builders（含按日期预算 key）。
2. `packages/storage/src/legacy-migration.ts` — legacy detail/meta/image 读取
   与幂等批量导入：D1 更新状态不覆盖、复用 R2 key、缺 key/坏 JSON 计数不阻塞。
3. `apps/sync-worker/src/migration-runner.ts` — ≤50/批、app_state 游标续跑、
   批次失败不阻断后续。
4. `packages/storage/src/shadow-compare.ts` — 规范化 legacy↔R2 比较：稳定排序、
   剔除运行时字段、脱敏 diff、水合等价。
5. `apps/sync-worker/src/read-mode.ts` — shadow streak 持久化、每日 KV 预算、
   7 日门禁、`switchReadMode`/`rollbackReadMode`（D1 权威 + KV 镜像）。
6. `apps/sync-worker/src/r2-publication.ts` — pointer key 参数化
   （`public:shadow-current`）与 `promoteShadowPointer`（验证后提升，幂等）。
7. `apps/read-worker/src/r2-snapshot.ts` — pointer/schema/generation/hash 校验、
   R2 加载、Cache API 缓存，失败顺序 R2 → 最后验证缓存 → legacy。
8. `apps/read-worker/src/health.ts` + index.ts — `public:read-mode` 接线
   （collections/calendar 直接服务 R2 快照），health 新增 snapshot/migration/
   budget/degraded，既有字段保留（handler 级测试）。
9. `apps/sync-worker/src/legacy-cleanup.ts` — 切换满 14 天、pointer+R2
   generation 验证后每天 ≤100 key 限速清理，游标续跑、失败批次不推进。
10. `apps/sync-worker/src/daily-shadow.ts` + workflow-core.ts — 每日调度 live
    发布后追加 shadow 阶段（增量同步 → shadow 发布 → 迁移 → 比较 → streak →
    预算 → 门禁提升/切换 → 清理），任一阶段失败只记录 `workflow_shadow_errors`
    不阻断 legacy 发布。

## OpenSpec requirement audit

5 个 delta spec（legacy-state-migration / shadow 等价 / public-read-contracts /
quality gates / cache-refresh-lifecycle）的 12 条 ADDED Requirements 均有
对应实现与可执行测试；Tasks 1.1-4.3、5.1、5.3 已勾选。

## Explicitly pending production evidence

- 部署到 `dev` 与 GitHub Actions pipeline：**pending**；
- 连续 7 次生产每日 shadow 一致 + KV 写预算达标（OpenSpec 6.1/6.2）：
  **pending 时间门禁**；
- 切换 `public:read-mode=r2` 后的生产冒烟：**pending**；
- 14 天观察与限速清理启动：**pending**；
- Comet build guard 与 verify 阶段转换：**待代码审查通过后执行**。
