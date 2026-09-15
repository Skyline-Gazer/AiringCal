# Task 2.2 实施报告：一次性 coordinator、run outcomes 与媒体生命周期

## 结果

完成 `apps/vps-sync` 的 one-shot coordinator 与 VPS media refresh port：

- `runOnce` 通过端口注入 lock、authority、完整上游输入、媒体、publication、backup、notification、clock 与 close；按 collection → complete state → media → publication → backup → notification 顺序推进并持续 heartbeat。
- 未取得业务锁时注册并持久化 `skipped`，不调用上游、媒体、publication 或 backup；完整抓取硬失败不提交 complete state。
- 终态由纯函数从组件结果派生：媒体或 backup 降级为 `partial`，publication `no_change` 保留 backup，`success`/`no_change`/`skipped` 映射退出码 0，`partial`/`failed` 映射非零；通知输入只包含稳定错误字段。
- media refresh 固定最多四个并发，按 `new_or_changed → hot → cold → retry` 和 subject ID 稳定排序，cold 使用 UTC 星期分片。
- subject session 在 row lock 内覆盖 detail/image fetch、图片校验、SHA-256、R2 PUT 与数据库 reference save；shadow 使用 `shadow/images/<hash>/original`，相同 hash/key 复用对象。
- detail、metadata、image 结果独立；图片瞬态/非法内容保留每个 size 的最后成功引用，缺失 source 只标记 image missing；subject detail 404 保留公开数据并写 24 小时 bounded tombstone。
- PostgreSQL authority 增加新 DTO 到既有 normalized schema 的映射、heartbeat、media candidate selection 和带 session lock 的 `withSubject`，并保持旧 repository API 兼容与 `(observed_at, run_id)` fence。

## 修改文件

- `apps/vps-sync/src/contracts.ts`
- `apps/vps-sync/src/media/refresh.ts`
- `apps/vps-sync/src/media/refresh.test.ts`
- `apps/vps-sync/src/run.ts`
- `apps/vps-sync/src/run.test.ts`
- `apps/vps-sync/src/postgres/repositories.ts`
- `docs/runbook/vps-data-plane.md`

未修改 plan、OpenSpec checkoff 或 `.comet.yaml`。

## TDD 证据

RED：

```text
pnpm -F @airing-cal/vps-sync test -- refresh.test.ts run.test.ts
```

新增测试先于生产实现运行。允许 `tsx` 创建 IPC 管道后，因 `src/media/refresh.js` 尚不存在而以 `ERR_MODULE_NOT_FOUND` 失败（预期行为 RED）；沙箱第一次运行另有 `listen EPERM`，不是行为级 RED 依据。

GREEN：

```text
pnpm -F @airing-cal/vps-sync test -- refresh.test.ts run.test.ts
```

通过：37 tests，30 passed，0 failed，7 个既有 PostgreSQL integration tests skipped。

## 验证命令

```text
pnpm -F @airing-cal/vps-sync typecheck   # PASS
pnpm -F @airing-cal/vps-sync test        # PASS（同上，7 DB tests skipped）
pnpm -F @airing-cal/vps-sync build       # PASS
git diff --check                         # PASS
```

## 已知局限与风险

- 本环境未提供 disposable PostgreSQL，因此真实 row/advisory lock、SQL DTO 映射、数据库 fence 与 rollback 集成断言仍为 skipped tests；必须由 CI/PostgreSQL 环境确认。
- coordinator 的 infrastructure composition root（S3/Feishu/实际 subject detail client）不在本 brief 允许文件内；`runOnce` 仅实现可注入端口。
- 媒体 404 tombstone 当前针对明确的 subject detail `null` 结果；图片响应的非 200 仍按可重试的媒体失败处理，以保留旧引用。

## Task 2.2 review follow-up（2026-09-15）

- 只有本轮明确的 detail `null` 会映射到 `not_found` 并创建 24 小时 tombstone。detail 网络/5xx 等瞬态失败保持最近成功的 detail、metadata 与 image refs，清除过期 `deletedAt`，并在一小时后重试；图片 429、5xx 响应或 fetch 超时/网络错误也使用一小时重试，非法图片内容仍走常规刷新周期。
- 新增 `0002_media_component_state.sql`，不改已存在的 `0001_initial.sql`，以 allow-listed JSONB 保存各组件 status、metadata 及 metadata/image hashes；旧行由 legacy aggregate 列兼容推导。SQL contract 测试验证失败状态不延长 tombstone，并验证组件状态 round-trip。
- complete-state 写入跳过未变化 subject/calendar 行；collection 计数分别区分 inserted、updated、unchanged，并由运行中的 SQL contract 测试覆盖。
- RED：review 回归在实现前共 41 tests，29 passed、5 failed、7 个 PostgreSQL integration tests skipped。GREEN：`pnpm test` 为 41 tests，34 passed、0 failed、7 skipped；`pnpm typecheck`、`pnpm build` 与 `git diff --check` 均通过。因环境未提供 PostgreSQL，真实 migration/row-lock/transaction integration coverage 仍待 CI 或 disposable PostgreSQL 执行。

## PostgreSQL integration follow-up（2026-09-15）

- CI run `34919316452`（commit `6f9fbcf`）确认 repository integration fixture 只执行 `0001_initial.sql`，没有 `0002_media_component_state.sql`，因此两个 media integration cases 报 `component_state` 列不存在。将 fixture 改为调用 `applyMigrations(pool)`，由仓库迁移入口应用全部 migration；migration 顺序及重复应用已有测试覆盖。
- 同一 run 的 publication case 收到 `RUN_CONFLICT` 而非预期的 `GENERATION_CONFLICT`。它在 `requireRun` 阶段失败；全迁移 fixture 下尚未有真实 PostgreSQL 重跑证据，因此本轮不改该断言或猜测原因，待本次 push 后 CI 复查。
- 本机没有可用 PostgreSQL 服务；`initdb` 在沙箱内因 shared-memory 权限失败，按要求不继续搭建本机数据库。标准 `pnpm -F @airing-cal/vps-sync test` 也因沙箱禁止 tsx IPC socket（`listen EPERM`）未能启动；等价本地 Node test runner 命令 `node --import tsx --test src/**/*.test.ts` 通过：51 tests，44 passed、0 failed、7 PostgreSQL tests skipped。`typecheck`、`build` 与 `git diff --check` 均通过。
- 下一轮 CI 对全迁移 repository integration fixture 的验证状态：待本修复 commit push 后触发。
