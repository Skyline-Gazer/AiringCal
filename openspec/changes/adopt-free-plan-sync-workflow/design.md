## Context

当前 `airing-cal-sync` 由每小时 Cron 或 `airing-cal-sync-trigger` Queue 启动。一次执行会分页获取全部收藏、获取 calendar、读取或刷新 subject detail/meta/image 状态、写正式 snapshot，再逐条向 Media Queue 投递。收藏规模和 7 天缓存集中到期时，业务执行时间会超过 CI 的等待窗口；部署流水线随后高频轮询 KV，最终即使 Worker 已成功部署也会因业务同步未完成而失败。

Cloudflare Workflows 在 Free Plan 下提供持久化 step、重试和 instance 运维，但每 step 只有 10 ms CPU、50 个 Worker API 调用、输出 1 MiB，账号每天最多 3,000 steps。设计必须让 step 小而确定，把大对象放 KV，把昂贵 subject/media 工作留在 Queue，并控制每天低于 1,000 steps。

## Goals / Non-Goals

**Goals:**

- 收藏和 calendar 快照在上游或媒体刷新失败时仍可原子地保留上一版。
- 每次同步有唯一 instance、确定性 step 名、持久化 stage/heartbeat/error，可通过 Cloudflare 控制面恢复或终止。
- 一次典型 live 同步约 100 steps，每 4 小时运行，满足 Free Plan 每日 3,000 steps 预算。
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

收藏第一页用 OpenAPI 最大 `limit=50` 取得 total，后续每页各一个 step；每页立即规范化后写 staging。calendar 单独获取并写 staging。五类收藏和 calendar 分别发布，subject ID 每 10 个生成一次候选 refresh job，enqueue 每 step 合并最多 3 个规划块。Workflow 不逐 subject 读取或写入 refresh/detail/meta/image 状态；Media consumer 在单消息 invocation 内用 SWR 与图片状态决定实际工作。step 只返回 key、count 和摘要，不返回完整 payload。

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
- [Free Plan 限额或计费规则变化] → step 数量和运行频率在测试与运维文档中显式记录，激活前使用官方控制面核对。前两个生产 shadow 证明多个快速 step 会在同一 Worker invocation 内累计 KV API 调用，因此 Workflow 不再执行逐 subject cache 查询；测试同时约束单 step 与整次 Workflow 的 KV 调用预算。

## Migration Plan

1. 先移除 CI post-deploy sync/KV polling，拆分 CI/deploy 并保持旧 Cron 业务路径可用。
2. 增加共享类型、缓存 key、BGM 请求边界与 Media Queue V2，保持旧 job 可兼容消费。
3. 部署无 schedule 的 Workflow binding，以显式 `shadow` instance 验证分页、step、retry、状态与输出。
4. 验证通过后独立提交 schedule 切换：启用每 4 小时 Workflow schedule并删除旧 Cron。
5. 观察至少一个完整 live instance 和 media backlog 收敛，再删除 trigger queue、旧 queue handler 与触发脚本。
6. 紧急回退时先移除 schedule、terminate 异常 instance，再部署上一稳定 commit；不删除 KV、R2、Queue 或 Workflow 资源，并保持新旧 key 兼容。

## Open Questions

- 正式 schedule 激活前，需要用生产 shadow 数据确认 549 条收藏的实际页数、step CPU 和 KV 写入规模没有超过 Free Plan 限额。
- trigger queue 的删除必须等待至少一个稳定 schedule 周期；具体删除提交由生产观察结果决定。
