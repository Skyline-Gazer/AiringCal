---
comet_change: adopt-free-plan-sync-workflow
role: technical-design
canonical_spec: openspec
---

# Free Plan Cloudflare Workflow 同步技术设计

## 架构边界

`SyncWorkflow` 是快照数据面的耐久编排器。它分页获取 collections 与 calendar，将规范化 payload 写入 instance staging KV，发布 shadow 或 live snapshot，规划 subject refresh jobs，并记录 `SyncRun`。它不调用 subject detail API，也不等待 Media Queue。

`airing-cal-media` 是 subject detail、metadata、图片与 R2 的唯一刷新执行器。Queue message 使用 `MediaRefreshJobV2`，以 `${instanceId}:${subjectId}` 为 `job_id`，并通过 `subject:refresh:{subjectId}` 去重和表达执行状态。旧缓存继续服务，下一刷新时间按 subject ID 分散到 6 至 8 天。

CI/CD 是控制面。它运行质量门禁、解析既有 Cloudflare 资源、部署 Worker/Workflow、检查 Workflow 注册状态并部署 frontend，不触发业务同步、不轮询 KV，也不等待 media backlog。

## Workflow 数据流

1. `initialize` 写入 `sync:run:{instanceId}`，记录 mode/source/status/stage/heartbeat。
2. `fetch-collections-page-0` 以 `limit=50` 获取 total 与第一页；后续页按页码创建固定 step，并把规范化数据写入 `sync:staging:{instanceId}:collections:{page}`。
3. `fetch-calendar` 写入 instance calendar staging。
4. `publish-{collectionType}` 与 `publish-calendar` 只读取 staging 和已有 cache。shadow 写 `snapshot:shadow:{instanceId}:*`；live 通过兼容提交点更新正式 snapshot。
5. `plan-refresh-{chunk}` 每 25 个 subject 检查 detail/meta/image/refresh 状态，生成最小刷新计划。
6. `enqueue-refresh-{chunk}` 使用 `Queue.sendBatch()`，每批不超过 100 条。shadow 跳过该阶段的副作用。
7. `finalize` 更新 summary、`sync:meta` 与最终 `SyncRun`。

所有外部 fetch、KV 和 Queue 副作用都位于 `step.do()`。step 名不使用时间或随机值，返回值只包含 staging key、count 和校验摘要。401/403 抛 `NonRetryableError`；429、5xx、timeout 和 network error按 45 秒 timeout、最多 3 次指数退避处理。

## 数据模型与兼容

- `sync:run:{instanceId}`：3 天 TTL，保存 Workflow 应用状态。
- `sync:staging:{instanceId}:*`：24 小时 TTL，保存 step 间大 payload。
- `snapshot:shadow:{instanceId}:*`：shadow 审计数据，不影响正式读取。
- `subject:refresh:{subjectId}`：queued/running/ok/partial/failed 与 `job_id`。
- `image:status:{subjectId}`：仅保存真实图片缓存结果。
- `sync:meta`：保留现有字段，增加 `workflow_instance_id` 和 `workflow_stage`。

迁移期间 read path 和 consumer 兼容旧 key/job。已激活 instance 的 step 名和输出 shape 不原地修改；不兼容行为使用新 step 名或 Workflow 版本。

## API 与请求边界

`BgmClient` 仅对 GET 使用 10 秒单次 timeout 和最多两次有限重试，并尊重有上限的 `Retry-After`；写 API 不隐式重试。`fetchAllCollections` 使用 50 条分页和 120 秒总预算。

账号 `/api/sync/apply` 直接消费 compare 返回的最多 5 个校验 items，不再每批重拉源 collections。旧 `subject_ids` 保留一个兼容版本。用户 token 不进入 Workflow、KV、Queue 或 operation log；敏感响应使用 `Cache-Control: no-store`。

`/api/cache` 使用 cursor pagination 且 `limit <= 100`；calendar hydration 限制并发。`/api/health` 返回最近 Workflow instance、stage、heartbeat、完成时间和脱敏错误，未完成且 20 分钟无 heartbeat 时标记 stale。

## 部署迁移

1. 第一批提交先移除部署后的 sync trigger 与 KV polling，拆分 CI/deploy，保留旧 Cron。
2. 上线 BGM 请求边界、缓存 refresh 状态和 Media Queue V2。
3. 注册不带 schedule 的 Workflow binding，手动运行生产 shadow instance。
4. shadow 核对 step 数、重试、输出、正式 key 隔离后，独立提交启用 `0 */4 * * *` 并删除旧 Cron。
5. 至少观察一个完整 live 周期和 media backlog 收敛后，删除旧 trigger queue/handler/script。

回退顺序为移除 schedule、终止异常 instance、部署上一稳定 commit；不删除 Workflow、KV、R2 或 Queue 资源。

## 验证重点

- 549 条收藏只产生 11 个获取 step，Workflow 不请求 subject API，step 输出小于 1 MiB。
- step 重放不重复提交 snapshot 或产生重复 media 副作用。
- shadow 不覆盖正式 key且不 enqueue；live 获取失败保留旧 snapshot。
- 100 个同时过期 subject 先发布 snapshot，再按 25 个规划 refresh。
- Media consumer 单消息、并发 4、瞬态 retry、终态 ack。
- apply 每批不调用 collections GET，超过 5 条返回 400，持久化载荷不含 token。
- CI 不包含 post-deploy sync/KV polling，frontend 不依赖业务缓存完成。
