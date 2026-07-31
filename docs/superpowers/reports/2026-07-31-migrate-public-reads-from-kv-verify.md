---
comet_change: migrate-public-reads-from-kv
role: task-12-verification-ready
status: verified-pending-production-observation
verified_scope: full-local-gates-migration-shadow-read-cutover-cleanup
verified_source_sha: 1d0e89c
---

# migrate-public-reads-from-kv verification-ready evidence

本文记录本地门禁证据；最终运行时 SHA `1d0e89c`（build → verify 守卫推进）。
未做远程迁移、merge、部署与生产观测；OpenSpec 6.1/6.2 生产验收项 pending。

## Full verification checklist（comet-verify full）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 1. tasks.md 全部完成 | PASS | 1.1-4.3、5.1、5.3 `[x]`；5.2 为生产时间门禁，显式 pending 并指向本报告 |
| 2. 实现符合 design.md 高层决策 | PASS | 幂等导入、shadow 门禁、pointer 切换、双 fallback、14 天清理均实现 |
| 3. 实现符合技术 Design Doc | PASS | §4.1-4.5/§5/§6 的模块与数据模型逐一落地 |
| 4. 能力规格场景全部通过 | PASS | 12 条 ADDED Requirements 有对应测试；全仓测试 exit 0 |
| 5. proposal.md 目标满足 | PASS | 导入/shadow 等价/安全切换/延迟清理全部达成 |
| 6. delta spec 与 design doc 无矛盾 | PASS | build 期仅勾选 tasks，未改 spec；design doc 与 specs 同源 |
| 7. design doc 可定位 | PASS | `docs/superpowers/specs/2026-07-31-migrate-public-reads-from-kv-design.md` 存在 |

## Fresh final gates（HEAD=1d0e89c）

| Command | Result |
|---|---|
| `CI=true pnpm test` | PASS（全仓，exit 0） |
| `CI=true pnpm typecheck` | PASS（9/9） |
| `CI=true pnpm build:check` | PASS（4/4 dry-run，read 100.78 KiB / sync 272.85 KiB） |
| `openspec validate --strict` | PASS |
| `git diff --check` | PASS |
| 硬编码密钥扫描（diff 非测试文件） | 无匹配 |

`openspec-verify-change` 技能在本环境不存在，按 comet-verify 回退执行等价完整
验证并在此记录；`requesting-code-review` 审查子代理通道故障，已按
requesting-code-review 回退做严格内联审查（见上文 Code-quality review）。

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

## Code-quality review

`requesting-code-review` 技能已加载；审查子代理两次派发均因平台子代理消息
通道故障未返回（与 `migrate_plan` 相同现象），按执行技能回退在主线严格内联
复查全部新增模块与接线点：

- `daily-shadow.ts`：每阶段独立 try/catch，错误带阶段前缀；增量/发布失败不阻断
  迁移与清理；门禁失败不提升/切换；比较用 `buildPublicSnapshot` 规范化 R2 候选，
  与 `readLegacyPublicResult` 的 legacy 水合结果同构。
- `workflow-core.ts`：`daily-shadow-phase` 步骤复用同 run 已暂存的
  `complete-input`（不二次抓取上游）；`legacySubjectKvWrites` 取 live 路径
  实际入队的 `refresh_jobs` 计数；shadow 阶段错误写入 `sync:meta` 的
  `workflow_shadow_errors`（≤10 条）且不改变 workflow 终态。
- `r2-snapshot.ts`：pointer 严格校验（schema/generation/hash/r2_key 模式）；
  R2 读取失败顺序为 R2 → 最后验证缓存 → legacy；缓存按 content_hash 键控。
- `legacy-cleanup.ts`：14 天观察期与 R2 generation 存在性双门禁；每天独立
  ≤100 key 上限（修复了累计计数误判）；失败批次不推进游标。
- `read-mode.ts`：switch/rollback 以 D1 `migrate:read-mode` 为权威、KV 为镜像
  （镜像失败重试）；streak 仅业务差异重置。
- `legacy-migration.ts`/`migration-runner.ts`：D1 更新状态与已导入内容不被
  legacy 覆盖；游标单调推进、缺 key/坏 JSON 计数不阻塞。
- `health.ts`：D1 不可读降级为 `degraded: true` 零值，不破坏既有字段。
- 结论：无 Critical/Important 遗留；仅有的偏差（worker-common 契约测试更新为
  “read handlers 消费 shadow bindings 且保留 legacy fallback”）是本 change
  的预期行为变更，已在提交说明记录。
