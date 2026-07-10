# Comet Design Handoff

- Change: adopt-free-plan-sync-workflow
- Phase: design
- Mode: compact
- Context hash: 89b89127f3eba3dcffa85ee537c8a5980f2dd8f6233b9e12fc6831a0cec33200

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/adopt-free-plan-sync-workflow/proposal.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/proposal.md
- Lines: 1-32
- SHA256: 3f07ab1f7cbbc4e988744b4ff651a5150b9544900d1ce847b6daa7faed853fb4

```md
## Why

当前定时同步把长时间业务刷新绑在 Worker Queue 与 CI/CD 部署之后，收藏分页、subject detail、metadata 和图片刷新会在同一轮集中执行，容易超过执行预算并留下永久 `running` 状态。需要在 Cloudflare Free Plan 限额内引入可恢复、可观测的 Workflow 编排，将快照发布与重型媒体刷新解耦，并让部署流程只负责交付代码和验证控制面。

## What Changes

- 新增 Cloudflare Workflow，同步收藏与 calendar、发布 shadow/live 快照、规划异步刷新任务，并持久化每次运行的阶段、心跳和结果。
- 将 subject detail、metadata、图片与 R2 刷新保留在 Media Queue，增加确定性任务 ID、去重状态和 stale-while-revalidate 生命周期。
- 将自动部署与业务同步解耦：CI/CD 不再触发 full sync 或轮询 KV，只部署并检查 Worker、Workflow 与绑定；Workflow schedule 在 shadow 验证后接管旧 Cron。
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
```

## openspec/changes/adopt-free-plan-sync-workflow/design.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/design.md
- Lines: 1-90
- SHA256: 5b9a663c2365d801572375c1f4a224cf34f5b5f1b23f32ba110bf116dd5e1b90

[TRUNCATED]

```md
## Context

当前 `airing-cal-sync` 由每小时 Cron 或 `airing-cal-sync-trigger` Queue 启动。一次执行会分页获取全部收藏、获取 calendar、读取或刷新 subject detail/meta/image 状态、写正式 snapshot，再逐条向 Media Queue 投递。收藏规模和 7 天缓存集中到期时，业务执行时间会超过 CI 的等待窗口；部署流水线随后高频轮询 KV，最终即使 Worker 已成功部署也会因业务同步未完成而失败。

Cloudflare Workflows 在 Free Plan 下提供持久化 step、重试和 instance 运维，但每 step 只有 10 ms CPU、50 个外部 subrequest、输出 1 MiB，账号每天最多 3,000 steps。设计必须让 step 小而确定，把大对象放 KV，把昂贵 subject/media 工作留在 Queue，并控制每天约 300 steps。

## Goals / Non-Goals

**Goals:**

- 收藏和 calendar 快照在上游或媒体刷新失败时仍可原子地保留上一版。
- 每次同步有唯一 instance、确定性 step 名、持久化 stage/heartbeat/error，可通过 Cloudflare 控制面恢复或终止。
- 一次典型同步约 45～50 steps，每 4 小时运行，满足 Free Plan 日预算。
- Workflow 只规划 subject 刷新，不调用 subject detail API；Media Queue 异步收敛 detail/meta/image/R2。
- 部署只验证和交付代码，不启动或等待业务同步。
- 账号 compare/apply、公开 cache API 和 bgm.tv GET 都具备有界输入、分页、超时和重试。

**Non-Goals:**

- 不把用户 token 放入 Workflow、KV、Queue 或 operation log。
- 不用 Workflow 替代 Media Queue、R2 或账号请求内的写操作。
- 不在本次变更中实现公共 Workflow 触发 HTTP endpoint。
- 不保证 shadow 部署提交立即启用正式 schedule；schedule 激活是生产验证后的独立原子步骤。

## Decisions

### 1. Workflow 只编排快照和刷新计划

新增 `SyncWorkflow`，参数为 `mode: shadow | live` 与 `source: manual`；schedule instance 默认 `live/schedule`。`event.instanceId` 作为 run ID，应用状态写入 `sync:run:{instanceId}`（3 天 TTL），暂存数据写入 `sync:staging:{instanceId}:*`（24 小时 TTL）。`sync:meta` 保留兼容字段并增加 Workflow instance 与 stage。

收藏第一页用 OpenAPI 最大 `limit=50` 取得 total，后续每页各一个 step；每页立即规范化后写 staging。calendar 单独获取并写 staging。五类收藏和 calendar 分别发布，subject ID 每 25 个规划一次 refresh，Queue 每批最多 100 条。step 只返回 key、count 和摘要，不返回完整 payload。

选择该边界是因为快照发布需要持久化编排，而 subject detail、图片下载和 R2 更适合 Queue 的并发与延迟重试。替代方案是每个 subject 一个 Workflow step，但会突破每日 step 预算并放大恢复成本。

### 2. 副作用按确定性 step 隔离并设计为幂等

所有 KV、Queue 和外部 fetch 都在 `step.do()` 内。step 名只由固定阶段、页码、收藏类型或 chunk index 构成，不含时间与随机数。publish step 根据 instance 与 mode 写固定 key；enqueue job 使用 `${instanceId}:${subjectId}` 作为 `job_id`，consumer 以刷新状态跳过重复消息。

网络 step 使用 45 秒 timeout、最多 3 次指数退避。401/403 转为 `NonRetryableError`；429、5xx、timeout 和 network error 重试。任一 collections/calendar fetch 最终失败时不执行正式 publish，上一版 live snapshot 保持不变。

替代方案是保留自建 KV 锁和单次 `waitUntil`，但它不能可靠恢复进程终止后的执行位置，也继续让状态与业务副作用耦合。

### 3. shadow 与 live 使用隔离的发布语义

`shadow` 写 `snapshot:shadow:{instanceId}:*` 和审计摘要，不覆盖 live key，也不投递 Media Queue。`live` 才更新正式 snapshot 和 enqueue refresh jobs。第一轮只注册 Workflow binding，保留旧 Cron；shadow 生产验证通过后，在同一原子提交中启用 `0 */4 * * *` Workflow schedule 并删除旧 `[triggers]` Cron，避免双重触发。

已激活 instance 使用的 step 名与返回结构在兼容窗口内冻结。破坏性变更通过新 step 名或 Workflow 版本演进。

### 4. subject 缓存采用 stale-while-revalidate

旧 detail/meta/image 继续可读。刷新到期时间按 subject ID 确定性分散到 6～8 天，避免同一天集中失效。新增 `subject:refresh:{subjectId}`，状态为 `queued/running/ok/partial/failed`；`image:status:*` 只表达真实图片缓存结果，不再兼任任务进度。

`MediaRefreshJobV2` 携带 `job_id`、待刷组件和已有源图 URL。consumer 一次处理一条，最大并发 4、最大重试 3；瞬态错误按 30/120/300 秒重试，404 和缺失源图写终态后 ack。快照发布不等待 media backlog。

### 5. 部署控制面与业务数据面解耦

`ci.yml` 对每次代码 push 执行 typecheck/test/build；`deploy.yml` 只对 `dev` 自动运行，手动运行可选 ref。全局 deployment concurrency 使用 `cancel-in-progress: false`，部署 job 设置明确 timeout。资源创建迁移到手动 bootstrap；常规 deploy 解析已有资源并对 Cloudflare API 设置 15 秒超时。

部署顺序固定为 validate → resolve resources → media/read workers → sync worker + Workflow → `wrangler workflows describe` → frontend。删除 post-deploy full sync、KV polling 和 consumer 自动修复。frontend 只依赖内部 Worker 成功，不依赖业务缓存新鲜度。

### 6. API 请求和账号同步必须有界

`BgmClient` GET 使用 10 秒单次 timeout、最多两次有限重试，并遵守有上限的 `Retry-After`；写请求不隐式重试。`fetchAllCollections` 使用 `limit=50` 和 120 秒总预算。

`/api/sync/apply` 优先接收 compare 返回的最多 5 个已校验 `items`，直接执行写操作，不再为每个 chunk 重拉全部源收藏。旧 `subject_ids` 保留一个版本且同样限制 5 条。operation log 在开始写 `running`，结束更新为 `ok/partial/error`，敏感响应统一 `Cache-Control: no-store`。

`/api/cache` 改为 cursor pagination 且 `limit <= 100`；calendar hydration 使用有界并发，公开请求不得展开全部 KV key。

## Risks / Trade-offs

- [KV 不是事务数据库，多 key publish 可能中途失败] → publish 使用 instance staging 与最终 summary/manifest 提交点；read path 只读取已提交版本或保留兼容 live key，失败测试验证不暴露部分结果。
- [Workflow step 的 10 ms CPU 预算较紧] → 每页即时规范化，组合拆到收藏类型/chunk，step 输出只含摘要；生产 shadow 检查 CPU 与输出大小。
- [Queue 至少一次投递会产生重复消息] → `job_id` 与 `subject:refresh:*` 共同去重，每个写入都按重复执行设计。
- [旧 Cron 与新 schedule 迁移时可能重叠] → 首发不启用 schedule，切换提交同时增新 schedule、删旧 Cron，并检查现有 instance。
- [降低 media 并发会延长图片最终收敛时间] → snapshot 先发布并继续服务 stale 内容，健康状态分别报告 Workflow 与 refresh backlog。
- [Free Plan 限额或计费规则变化] → step 数量和运行频率在测试与运维文档中显式记录，激活前使用官方控制面核对。

## Migration Plan

1. 先移除 CI post-deploy sync/KV polling，拆分 CI/deploy 并保持旧 Cron 业务路径可用。
```

Full source: openspec/changes/adopt-free-plan-sync-workflow/design.md

## openspec/changes/adopt-free-plan-sync-workflow/tasks.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/tasks.md
- Lines: 1-54
- SHA256: 75199bb06bf869b042ec0488a36a5235a3a3aca9516bd2ca40e852217667d8be

```md
## 1. 解除部署与业务同步耦合

- [ ] 1.1 先更新部署配置测试，要求仅 `dev` 自动部署、全局 concurrency、job timeout、无 post-deploy sync/KV polling
- [ ] 1.2 拆分 `ci.yml` 与 `deploy.yml`，删除缓存刷新 job，并让 frontend 只依赖内部 Worker 与 Workflow 控制面检查
- [ ] 1.3 将 Cloudflare 资源创建迁移到手动 bootstrap workflow，常规部署只解析既有资源且 API 请求有 15 秒 timeout
- [ ] 1.4 同步部署文档并运行部署配置测试、typecheck、build check 后原子 commit/push

## 2. 约束 bgm.tv 请求与账号 apply

- [ ] 2.1 先为 GET timeout、两次有限重试、Retry-After、写请求不重试和 549 条收藏 11 页补失败测试
- [ ] 2.2 实现 `BgmClient` GET 10 秒 timeout、可重试错误分类和 `fetchAllCollections` 50 条分页/120 秒总预算
- [ ] 2.3 先为 apply items 上限、旧 subject_ids 兼容、零 collections 重拉与 no-store/脱敏日志补失败测试
- [ ] 2.4 实现 compare items 直接 apply、最多 5 条、一个版本的旧输入兼容和 operation log 终态更新
- [ ] 2.5 同步账号 API 文档并运行 bgm-api/frontend-worker 测试后原子 commit/push

## 3. 建立缓存刷新生命周期

- [ ] 3.1 先为 Workflow run/staging/shadow key、`subject:refresh` 状态和 6～8 天确定性刷新窗口补失败测试
- [ ] 3.2 在 storage/domain 中实现兼容 key、`SyncRun`、refresh 状态、`MediaRefreshJobV2` 与 SWR 判断
- [ ] 3.3 先为 Media consumer job 去重、单消息、瞬态 delay retry、404/missing source 终态 ack 补失败测试
- [ ] 3.4 实现 Media consumer V2 幂等处理与 refresh/image 状态分离，并兼容旧消息过渡
- [ ] 3.5 将 Media Queue 配置改为 batch 1、timeout 5、concurrency 4、retries 3，更新文档并原子 commit/push

## 4. 实现 shadow Workflow 编排

- [ ] 4.1 建立 fake Workflow step 测试，覆盖确定性 step 名、step 小输出、401/403 不重试、429/5xx/timeout 重试
- [ ] 4.2 补充 100 个同时到期 subject 的 25 条规划分组、sendBatch 上限、重复 enqueue job_id 去重测试
- [ ] 4.3 实现 `SyncWorkflow` initialize、收藏分页、calendar staging 与运行状态/heartbeat
- [ ] 4.4 实现五类收藏/calendar 的 shadow/live 发布与失败保留旧 snapshot
- [ ] 4.5 实现 refresh plan/enqueue/finalize，确保 Workflow 不调用 subject detail API
- [ ] 4.6 在 Wrangler 配置注册无 schedule 的 Workflow binding，生成并核对 Worker 类型
- [ ] 4.7 更新 Workflow 架构、key、状态与手动 shadow 运维文档，完整验证后原子 commit/push

## 5. 收敛读取 API 与健康状态

- [ ] 5.1 先为 `/api/health` 最近 instance/stale 状态和 `/api/cache` cursor/limit/有界 hydration 补失败测试
- [ ] 5.2 实现健康 API 的 Workflow 摘要与 20 分钟 stale 判定
- [ ] 5.3 实现 cache cursor pagination、`limit <= 100` 和 calendar 有界 hydration
- [ ] 5.4 更新 endpoint 文档并运行 read/frontend 测试后原子 commit/push

## 6. Shadow 生产验证与 schedule 切换

- [ ] 6.1 使用已验证的 Wrangler CLI 显式创建生产 shadow instance 并核对 instance、step、retry、输出与正式 key 隔离
- [ ] 6.2 修复 shadow 发现的问题并重新执行全量 typecheck/test/build/diff-check
- [ ] 6.3 启用 `0 */4 * * *` Workflow schedule 并同时删除旧 Worker Cron，更新运行与回退文档后原子 commit/push
- [ ] 6.4 观察至少一个完整 live instance，确认正式 snapshot 更新、media backlog 异步收敛且无永久 running

## 7. 移除旧触发路径并完成发版

- [ ] 7.1 先更新测试要求不存在 sync trigger queue、旧 queue handler、consumer 自动修复和 `push-sync-trigger.mjs`
- [ ] 7.2 删除 `airing-cal-sync-trigger` 配置、旧 queue handler 与触发脚本，并更新 bootstrap/资源文档
- [ ] 7.3 审计 README、endpoint、环境变量、Worker、Workflow、日志事件、配置与发版文档，删除未实现或过时声明
- [ ] 7.4 运行 `pnpm typecheck`、`pnpm test`、`pnpm build:check`、`git diff --check` 与本地 Workflow smoke test
- [ ] 7.5 核对生产控制面与健康 API，提交并 push 最终发版原子提交
```

## openspec/changes/adopt-free-plan-sync-workflow/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-41
- SHA256: dfb7c8c81655260a7ec3c92a821186eafd9abc3592e5ba44d31df035dbd0982d

```md
## ADDED Requirements

### Requirement: subject 缓存必须支持过期继续服务
系统 MUST 在 subject detail、metadata 或图片进入刷新窗口后继续提供旧缓存，并异步规划刷新任务。

#### Scenario: detail 已进入刷新窗口
- **WHEN** 读取到已有 subject detail 且其确定性刷新时间已到
- **THEN** 快照仍使用旧 detail 并为该 subject 规划刷新

### Requirement: subject 刷新时间必须分散
系统 MUST 根据 subject ID 将常规刷新时间确定性分散在 6 至 8 天，避免同批缓存同时到期。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个不同 subject 在同一时刻完成刷新
- **THEN** 其下一次刷新时间按 subject ID 分散而不是落在同一时刻

### Requirement: Media Queue 消息必须可去重
每个刷新消息 MUST 包含由 Workflow instance 与 subject ID 组成的 `job_id`，consumer MUST 跳过已经完成或正在处理的重复 job。

#### Scenario: enqueue step 重放
- **WHEN** 同一 enqueue step 因恢复再次投递相同 job
- **THEN** Media consumer 不重复下载、写 R2 或覆盖已完成状态

### Requirement: 刷新状态与图片结果必须分离
系统 MUST 用 `subject:refresh:{subjectId}` 表达 queued/running/ok/partial/failed，用 `image:status:{subjectId}` 只表达真实图片缓存结果。

#### Scenario: metadata 成功但图片缺少源 URL
- **WHEN** Media consumer 成功更新 metadata 但无法取得图片源 URL
- **THEN** refresh 状态为 partial 或相应终态且 image status 不得伪装为任务成功

### Requirement: Media Queue 重试必须区分瞬态与终态
consumer MUST 对 timeout、network、429 与 5xx 使用有界延迟重试，对 404 与缺失源图写终态后 ack。

#### Scenario: 图片上游暂时返回 503
- **WHEN** 图片下载返回 503 且未超过最大重试次数
- **THEN** 消息按 30、120、300 秒策略中的相应延迟重试

#### Scenario: subject 不存在
- **WHEN** subject detail 返回 404
- **THEN** consumer 写入不存在终态并 ack 消息

```

## openspec/changes/adopt-free-plan-sync-workflow/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/specs/durable-sync-workflow/spec.md
- Lines: 1-48
- SHA256: b655e4b248392884e18368607932f7ff7897b8d935c3c620fce9f4e979e04f62

```md
## ADDED Requirements

### Requirement: 同步必须由可恢复 Workflow 编排
系统 MUST 使用 Cloudflare Workflow 编排收藏、calendar、快照发布与刷新规划，并为每次 instance 持久化可观测运行状态。

#### Scenario: instance 在中途恢复
- **WHEN** Workflow 在已完成若干分页 step 后恢复
- **THEN** 系统从持久化 step 继续且不重复已完成的外部副作用

### Requirement: Workflow step 必须确定且有界
系统 MUST 使用由阶段、页码、收藏类型或 chunk index 决定的 step 名，并确保每个 step 的外部请求数、CPU 与输出满足 Free Plan 限额。

#### Scenario: 549 条收藏分页
- **WHEN** 收藏接口报告 549 条记录且每页上限为 50
- **THEN** Workflow 只创建 11 个收藏获取 step 且每个 step 输出仅包含 key、数量和摘要

### Requirement: shadow 与 live 发布必须隔离
手动 Workflow MUST 明确选择 `shadow` 或 `live`；shadow 不得覆盖正式 snapshot 或投递 Media Queue，schedule MUST 以 live 模式运行。

#### Scenario: shadow 验证
- **WHEN** 运维创建 shadow instance
- **THEN** 系统只写该 instance 的 shadow snapshot 与审计结果且正式 snapshot 保持不变

### Requirement: 获取失败必须保留上一版正式快照
collections 或 calendar 获取最终失败时，系统 MUST 记录错误状态并保留上一版完整正式 snapshot。

#### Scenario: calendar 重试耗尽
- **WHEN** calendar 请求在允许的重试后仍失败
- **THEN** Workflow 以 error 结束且不发布本次正式收藏或 calendar

### Requirement: Workflow 网络错误必须分类重试
系统 MUST 将 401/403 视为不可重试错误，并对 429、5xx、timeout 与 network error 执行有界指数退避。

#### Scenario: 上游鉴权失败
- **WHEN** 收藏请求返回 401 或 403
- **THEN** 当前 step 不再重试并以脱敏错误结束 instance

#### Scenario: 上游限流
- **WHEN** 收藏请求返回 429
- **THEN** 当前 step 按配置重试且不会覆盖上一版正式 snapshot

### Requirement: Workflow 状态必须可观测
系统 MUST 保存 instance ID、mode、source、status、stage、heartbeat、完成时间、页数、subject 数量、刷新任务数与脱敏错误，并在健康 API 暴露最近运行摘要。

#### Scenario: heartbeat 过期
- **WHEN** 应用记录超过 20 分钟没有 heartbeat 且未完成
- **THEN** 健康 API 将应用状态标记为 stale 并保留 Cloudflare instance ID 供控制面核对

```

## openspec/changes/adopt-free-plan-sync-workflow/specs/project-quality-gates/spec.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/specs/project-quality-gates/spec.md
- Lines: 1-45
- SHA256: 7ada106e53a3a06b621274fa86f2d511930dc716639eed646a0b346ad06508fb

```md
## MODIFIED Requirements

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权、同步输入验证、Workflow 幂等发布、Queue 去重与部署业务解耦 MUST 有可运行的自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试重复执行相同 enqueue step
- **THEN** 测试验证相同 `job_id` 不会产生重复媒体副作用

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript 类型检查、自动测试和 Wrangler dry-run；部署 Workflow 后 MUST 检查其 Cloudflare 控制面注册状态。

#### Scenario: Workflow binding 与 class 漂移
- **WHEN** 配置引用不存在的 Workflow class 或 binding
- **THEN** 类型、bundle 或控制面检查失败且 frontend 不继续部署

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、同步行为、Workflow 运维命令及部署流程一致，且不得声明未启用的 schedule 或已删除的 trigger queue。

#### Scenario: schedule 尚未激活
- **WHEN** Workflow 已部署但生产 shadow 尚未通过
- **THEN** 文档明确 schedule 未启用且旧 Cron 仍是正式触发源

## ADDED Requirements

### Requirement: 部署不得等待业务同步
CI/CD MUST 只部署代码、解析既有资源并验证控制面，不得触发 full sync、轮询业务 KV 或等待媒体缓存收敛。

#### Scenario: 内部 Worker 部署完成
- **WHEN** read、media、sync Worker 与 Workflow 成功部署并通过控制面检查
- **THEN** frontend 部署立即继续且不读取 `sync:meta.synced_at`

### Requirement: 自动部署必须串行且来源唯一
自动 deploy MUST 只监听 `dev`，并使用不取消当前运行的全局 concurrency；手动 deploy MUST 显式解析所选 ref。

#### Scenario: 连续推送多个原子提交
- **WHEN** 当前部署运行中又有多个 dev push 到达
- **THEN** 当前部署完成且 pending 只保留最新一次，不出现 dev/main 并行竞争同一 Worker

### Requirement: 公开缓存读取必须有界
公开 cache API MUST 使用 cursor pagination、限制 `limit <= 100`，calendar hydration MUST 使用有界并发且不得单次展开全部 KV key。

#### Scenario: 请求过大 limit
- **WHEN** 客户端请求 limit 大于 100
- **THEN** API 拒绝或收敛到上限且不会扫描全部缓存
```

## openspec/changes/adopt-free-plan-sync-workflow/specs/sync-consistency/spec.md

- Source: openspec/changes/adopt-free-plan-sync-workflow/specs/sync-consistency/spec.md
- Lines: 1-47
- SHA256: 5fab5f0059caf4537e62bc4f5a822217a4def03c75d8f7a93027d7c1b460c8e7

```md
## MODIFIED Requirements

### Requirement: 同步快照必须完整提交
收藏与日历 MUST 作为同一次 Workflow instance 的结果提交；生成或发布阶段失败时不得向读取端暴露部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但日历获取失败
- **THEN** 系统保留上一次完整快照并记录失败状态

#### Scenario: 发布中途失败
- **WHEN** 部分 staging 数据已写入但最终提交点失败
- **THEN** 读取端继续使用上一次已提交 snapshot

### Requirement: 同步执行不得重叠
系统 MUST 防止旧 Cron、Workflow schedule 与手动 live instance 同时刷新同一 token 或提交同一正式快照；shadow instance 不得产生正式副作用。

#### Scenario: 已有 live 同步正在执行
- **WHEN** 第二个 live 同步在活动 instance 仍运行时到达
- **THEN** 系统拒绝或跳过第二次执行且不刷新 token或写正式 snapshot

### Requirement: 同步输入必须验证
系统 MUST 验证模式、方向、用户名、token、条目 ID 与 apply items；无效输入或超过批量上限的输入不得触发 bgm.tv 写操作。

#### Scenario: 模式无效
- **WHEN** 请求提供非 full 或 partial 的模式
- **THEN** 系统返回 400 且不调用 bgm.tv

#### Scenario: apply 超过五条
- **WHEN** 请求包含超过 5 个 items 或 subject IDs
- **THEN** 系统返回 400 且不读取全部源收藏或调用 bgm.tv 写接口

## ADDED Requirements

### Requirement: compare 结果必须可直接用于 apply
`/api/sync/apply` MUST 接收最多 5 个经过校验的 compare items 并直接执行对应写操作，不得为每个批次重新拉取全部源收藏。

#### Scenario: 使用 compare items 应用一批变更
- **WHEN** 客户端提交 5 个有效 compare items
- **THEN** apply 使用这些 items 且不调用源账户 collections GET

### Requirement: 用户凭证不得进入异步或持久化业务载荷
用户 token MUST 仅在当前受保护请求内使用，不得写入 Workflow params、KV、Queue 或 operation log。

#### Scenario: 账号同步结束
- **WHEN** compare 或 apply 请求完成
- **THEN** operation log 和所有异步消息不包含源或目标 token

```

