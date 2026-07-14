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

`shadow` 写 `snapshot:shadow:{instanceId}:*` 和审计摘要，不覆盖 live key，也不投递 Media Queue。`live` 才更新正式 snapshot 和 enqueue refresh jobs。原生 Workflow schedule 需要付费计划；Free Plan 使用 `0 */4 * * *` Worker Cron，但 handler 只以确定性 ID 创建 live Workflow instance，不执行同步业务。

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

### 7. 正式快照提交必须由 Durable Object 串行化

审计确认 KV 的读后写检查无法阻止较旧 Workflow 晚完成并覆盖较新快照。新增 SQLite-backed `SnapshotCoordinator`，全局使用固定实例名 `snapshot-global`。`allocate(instanceId)` 原子分配单调递增的 `generation`，相同 instance 重放返回原 generation；initialize 同时写独立 `sync:current` 指针，使尚未 finalize 或硬中断的运行仍可被 health 定位。`commit(generation, manifest)` 只接受大于 `lastCommittedGeneration` 的 generation，并通过显式实例 mutex 将 Durable Object storage 与外部 KV await 包在同一串行临界区内更新完整 `snapshot:active` manifest。

live Workflow 的顺序固定为 initialize generation/current run → fetch/staging → publish versioned keys → build refresh plan → enqueue 全部 V3 jobs → coordinator commit → finalize run/meta。任一 versioned key 写入或 enqueue 失败时不得提交 active pointer；较旧 Workflow 晚到时得到 `obsolete`，不得覆盖新 active snapshot。V3 active manifest 存在时，read path 必须校验五类 collection、summary、calendar 的精确 key 集合与摘要，缺失时返回 `SNAPSHOT_INCOMPLETE` 503，禁止逐 key legacy fallback；active 不存在或仅为不含任何 V3 字段的迁移前 pointer 时，才允许整套 legacy 兼容读取。

### 8. Media 刷新必须按 subject 和 generation 串行化

新增 SQLite-backed `SubjectRefreshCoordinator`，每个 subject 使用 `idFromName(String(subjectId))`。`MediaRefreshJobV3` 在 V2 字段上增加 Workflow generation；显式实例 mutex 保持跨 bgm、KV、R2 await 的整个 `/process` 请求串行，同一 subject 的 detail/meta/image/R2 与成功或失败刷新状态副作用都在该临界区内完成。coordinator 在副作用开始前持久化最高已接受 generation，因此新 generation 失败后，小于它的消息仍直接返回 `obsolete` 并 ack，不得写 KV/R2；同 generation 的重放保持幂等。V2/legacy 消息按 generation `0` 兼容，且只允许在没有更高 V3 generation 时执行。

### 9. 部署 revision、配额与回退必须可证明

部署 workflow 增加不接触 production secrets 的 `resolve_ref` job。自动 push 固定使用事件完整 commit SHA；手动 ref 解析成完整 SHA 后，必须通过 `git merge-base --is-ancestor <sha> origin/dev`。所有后续 job 只 checkout 该唯一 SHA，`BANGUMI_GIT_COMMIT_SHA` 也使用它。在任何 Worker 上传前运行 Cron 配额 preflight；失败时不得产生部分部署。README 提供正式 rollback runbook，按暂停 Cron、terminate 异常 Workflow、选择 `dev` ancestor 稳定 SHA、不可变 SHA 部署、验证 binding/migration/health/generation、恢复 Cron 的顺序执行。SQLite migration 不自动删除，回退代码保持新 binding/class 可加载。

## Risks / Trade-offs

- [KV 不是事务数据库，多 key publish 可能中途失败] → publish 使用 instance staging 与最终 summary/manifest 提交点；read path 只读取已提交版本或保留兼容 live key，失败测试验证不暴露部分结果。
- [KV 也不能提供跨 Workflow 的原子 compare-and-set] → generation 分配与 active pointer 提交移入全局 SQLite Durable Object；KV 只保存 versioned payload 与可观测指针。
- [Workflow step 的 10 ms CPU 预算较紧] → 每页即时规范化，组合拆到收藏类型/chunk，step 输出只含摘要；生产 shadow 检查 CPU 与输出大小。
- [Queue 至少一次投递会产生重复消息] → `job_id` 与 `subject:refresh:*` 共同去重，每个写入都按重复执行设计。
- [旧业务 Cron 与新触发器迁移时可能重叠] → 切换时删除旧业务 handler 与 trigger queue，只保留创建 Workflow instance 的轻量 Worker Cron，并检查现有 instance。
- [降低 media 并发会延长图片最终收敛时间] → snapshot 先发布并继续服务 stale 内容，健康状态分别报告 Workflow 与 refresh backlog。
- [Free Plan 限额或计费规则变化] → step 数量和运行频率在测试与运维文档中显式记录，激活前使用官方控制面核对。前两个生产 shadow 证明多个快速 step 会在同一 Worker invocation 内累计 KV API 调用，因此 Workflow 不再执行逐 subject cache 查询；测试同时约束单 step 与整次 Workflow 的 KV 调用预算。

## Migration Plan

1. 先移除 CI post-deploy sync/KV polling，拆分 CI/deploy 并保持旧 Cron 业务路径可用。
2. 增加共享类型、缓存 key、BGM 请求边界与 Media Queue V2，保持旧 job 可兼容消费。
3. 部署无 schedule 的 Workflow binding，以显式 `shadow` instance 验证分页、step、retry、状态与输出。
4. 验证通过后独立提交触发器切换：启用每 4 小时 Worker Cron 桥接并删除旧业务 Cron。
5. 观察至少一个完整 live instance 和 media backlog 收敛，再删除 trigger queue、旧 queue handler 与触发脚本。
6. 先部署两个 SQLite Durable Object class/binding 并验证可加载，再切换 Workflow 与 Media 调用路径；migration 不自动删除。
7. 紧急回退时先移除 Worker Cron、terminate 异常 instance，再以已进入 `dev` 历史的不可变稳定 SHA 部署；不删除 Durable Object、KV、R2、Queue 或 Workflow 资源，并保持新 binding/class 可加载。

## Open Questions

- 正式 schedule 激活前，需要用生产 shadow 数据确认 549 条收藏的实际页数、step CPU 和 KV 写入规模没有超过 Free Plan 限额。
- trigger queue 的删除必须等待至少一个稳定 schedule 周期；具体删除提交由生产观察结果决定。
