---
comet_change: adopt-free-plan-sync-workflow
role: technical-design
canonical_spec: openspec
---

# Free Plan Cloudflare Workflow 同步技术设计

## 架构边界

`SyncWorkflow` 是快照数据面的耐久编排器。它分页获取 collections 与 calendar，将规范化 payload 写入 instance staging KV，发布 shadow 或 live snapshot，规划 subject refresh jobs，并记录 `SyncRun`。它不调用 subject detail API，也不等待 Media Queue。

`airing-cal-media` 是 subject detail、metadata、图片与 R2 的唯一刷新执行器。Queue message 使用带 Workflow generation 的 `MediaRefreshJobV3`，以 `${instanceId}:${subjectId}` 为 `job_id`；每个 subject 的 `SubjectRefreshCoordinator` SQLite Durable Object 使用覆盖 bgm.tv、KV 与 R2 await 的互斥区串行化全部副作用和失败状态，并在副作用前持久化最高已接受 generation，因此新任务失败后迟到旧任务仍会被拒绝。旧 V2/legacy job 按 generation 0 兼容。旧缓存继续服务，下一刷新时间按 subject ID 分散到 6 至 8 天。

CI/CD 是控制面。它运行质量门禁、解析既有 Cloudflare 资源、部署 Worker/Workflow、检查 Workflow 注册状态并部署 frontend，不触发业务同步、不轮询 KV，也不等待 media backlog。

## Workflow 数据流

1. `initialize` 通过全局 `SnapshotCoordinator` SQLite Durable Object 分配单调 generation，写入 `sync:run:{instanceId}` 与 `sync:current`，记录 mode/source/status/stage/heartbeat。
2. `fetch-collections-page-0` 以 `limit=50` 获取 total 与第一页；后续页按页码创建固定 step，并把规范化数据写入 `sync:staging:{instanceId}:collections:{page}`。
3. `fetch-calendar` 写入 instance calendar staging。
4. `publish-{collectionType}` 与 `publish-calendar` 只读取 staging 和已有 cache。shadow 写 `snapshot:shadow:{instanceId}:*`；live 写 generation-scoped versioned keys，但此时不改变 active pointer。
5. `plan-refresh-{chunk}` 每 10 个 subject 生成确定性的候选 V3 job，不逐 subject 读取 refresh/detail/meta/image KV。
6. `enqueue-refresh-{chunk}` 每 step 合并最多 3 个规划块并使用 `Queue.sendBatch()`；shadow 跳过该阶段的副作用。Media consumer 在单消息 invocation 内判断 fresh/missing 并写 refresh 状态。
7. 全部 versioned key 和 V3 job enqueue 成功后，`SnapshotCoordinator.commit()` 在覆盖外部 KV await 的互斥区内原子接受最新 generation 的完整 manifest；较旧 Workflow 返回 `obsolete`。
8. `finalize` 更新 summary、`sync:meta` 与最终 `SyncRun`。

所有外部 fetch、KV 和 Queue 副作用都位于 `step.do()`。step 名不使用时间或随机值，返回值只包含 staging key、count 和校验摘要。401/403 抛 `NonRetryableError`；429、5xx、timeout 和 network error按 45 秒 timeout、最多 3 次指数退避处理。

## 数据模型与兼容

- `sync:run:{instanceId}`：3 天 TTL，保存 Workflow 应用状态。
- `sync:staging:{instanceId}:*`：24 小时 TTL，保存 step 间大 payload。
- `snapshot:shadow:{instanceId}:*`：shadow 审计数据，不影响正式读取。
- `snapshot:active`：包含 instance、generation、恰好五类 collection + summary + calendar keys 与 digests 的完整 manifest；V3 manifest 存在时禁止逐 key legacy fallback。
- `sync:current`：initialize 阶段即写入的当前运行指针，供 running/hard-interrupt/stale health 定位。
- `subject:refresh:{subjectId}`：queued/running/ok/partial/failed 与 `job_id`。
- `image:status:{subjectId}`：仅保存真实图片缓存结果。
- `sync:meta`：保留现有字段，增加 `workflow_instance_id` 和 `workflow_stage`。

迁移期间仅在 `snapshot:active` 不存在，或 pointer 恰好是合法的 `instance_id`、`mode: live`、`published_at`、`subject_count` 旧四字段结构时整套读取旧 key；截断旧 pointer 返回 503。出现任一 V3 字段后，manifest 不是准确七个 required key、任一 key 缺失或摘要不匹配也返回 503 `SNAPSHOT_INCOMPLETE`。consumer 兼容旧 job，但 generation 0 不得覆盖已接受的 V3 generation。已激活 instance 的 step 名和输出 shape 不原地修改；不兼容行为使用新 step 名或 Workflow 版本。

## API 与请求边界

`BgmClient` 仅对 GET 使用 10 秒单次 timeout 和最多两次有限重试，并尊重有上限的 `Retry-After`；写 API 不隐式重试。`fetchAllCollections` 使用 50 条分页和 120 秒总预算。

账号 `/api/sync/apply` 直接消费 compare 返回的最多 5 个校验 items，不再每批重拉源 collections。旧 `subject_ids` 保留一个兼容版本。用户 token 不进入 Workflow、KV、Queue 或 operation log；敏感响应使用 `Cache-Control: no-store`。

`/api/cache` 使用 cursor pagination 且 `limit <= 100`；calendar hydration 限制并发。`/api/health` 通过 `sync:current` 返回实际当前 Workflow instance、stage、heartbeat、完成时间和脱敏错误，未完成且 20 分钟无 heartbeat 时生成唯一 effective stale 状态，并让 `workflow.status` 与兼容 `cron.last.status` 保持一致。

## 部署迁移

1. 第一批提交先移除部署后的 sync trigger 与 KV polling，拆分 CI/deploy，保留旧 Cron。
2. 上线 BGM 请求边界、缓存 refresh 状态和 Media Queue V2。
3. 注册不带 schedule 的 Workflow binding，手动运行生产 shadow instance。
4. shadow 核对 step 数、重试、输出、正式 key 隔离后，独立提交启用 `0 */4 * * *` Worker Cron 桥接并删除旧业务 Cron。
5. 至少观察一个完整 live 周期和 media backlog 收敛后，删除旧 trigger queue/handler/script。
6. 增加 `resolve_ref` job，将自动或手动 ref 固定成 `dev` ancestor 的完整 SHA；所有部署 job checkout 同一 SHA，并在任何上传前完成 Cron 配额 preflight。任一部署 job 失败时，`recovery_report` 查询四个 Worker 当前 deployment JSON、汇总 job 结果并输出使用该完整 SHA 的精确收敛命令。

回退顺序为移除 schedule、终止异常 instance、以已进入 `dev` 的不可变稳定 SHA 部署、验证 Workflow/DO/health/active generation、恢复 schedule；不删除 Workflow、Durable Object、KV、R2 或 Queue 资源。

## 验证重点

- 549 条收藏只产生 11 个获取 step，Workflow 不请求 subject API，step 输出小于 1 MiB。
- step 重放不重复提交 snapshot 或产生重复 media 副作用。
- T2 generation 先 commit、T1 后 commit 时 active 保持 T2；active 缺 required key 时返回 503 而不混入 legacy。
- shadow 不覆盖正式 key且不 enqueue；live 获取失败保留旧 snapshot。
- 100 个 subject 先发布 snapshot，再按 10 个生成候选 refresh job；测试统计 plan step KV 调用不超过 3、enqueue step 不超过 4，Workflow 总 KV 调用保持在 500 以下。
- Media consumer 单消息、并发 4、瞬态 retry、终态 ack。
- 同 subject 新 job 先完成、旧 job 后到达时旧 job obsolete，KV/R2 状态保持新 generation。
- apply 每批不调用 collections GET，超过 5 条返回 400，持久化载荷不含 token。
- CI 不包含 post-deploy sync/KV polling，frontend 不依赖业务缓存完成。
- 任意 deploy job 使用同一解析 SHA；非 `dev` ancestor ref 与 Cron 配额不足都在 secrets/上传前失败。
