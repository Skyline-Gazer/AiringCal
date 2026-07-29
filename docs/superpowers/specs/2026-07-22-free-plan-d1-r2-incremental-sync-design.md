---
comet_change: adopt-d1-r2-incremental-sync
role: technical-design
canonical_spec: openspec
---

# AiringCal D1/R2 增量同步技术设计

## 1. 目标与边界

本 change 将可变权威状态从 Workers KV 迁到 D1，将可重建的公开结果发布为独立 R2 数据对象，并把新链路中的 KV 写入收缩为内容变化时的一次 pointer 更新。同步频率保持每天 04:00 Asia/Shanghai。

本 change 负责：

- 创建、解析和绑定 D1 `airing-cal-state` 与数据桶 `airing-cal-data`。
- 建立 D1 schema、稳定规范化/hash、收藏增量 diff、两次缺失确认和 D1 预算。
- 生成并验证不可变 `PublicSnapshotV1`，最后更新 `public:current`。
- 以 shadow publication 方式上线新链路并保留现有公开读取。

本 change 不负责：

- 不把 `/api/collections`、`/api/calendar` 或 `/api/health` 切换到新 R2 snapshot。
- 不导入或删除旧逐 subject KV，不清理旧 snapshot key。
- 不复制 `airing-cal-images` 中的图片对象。
- 不在媒体任务完成后同日进行第二次公开 snapshot 发布。

公开读取切换、legacy import、一致性门禁、回滚操作和清理由 `migrate-public-reads-from-kv` change 完成。

## 2. 资源与部署分层

### 2.1 Cloudflare 资源

| 资源 | 名称 | 用途 |
|---|---|---|
| D1 | `airing-cal-state` | 收藏、媒体、同步、预算和应用状态的权威存储 |
| R2 data bucket | `airing-cal-data` | 不可变公开 JSON snapshot |
| R2 image bucket | `airing-cal-images` | 现有图片二进制，保持不变 |
| KV | `airing-cal-kv` | 兼容期旧数据与新 `public:current` pointer |
| Queue | `airing-cal-media` | 有界媒体补全任务 |

`sync-worker` 绑定 D1、data R2、KV 和 Media Queue；`media-worker` 绑定 D1 与 image R2；`read-worker` 在本 change 中可以获得兼容 binding，但仍使用旧 KV 公开读取路径。

### 2.2 两阶段兼容发布

资源变更与 binding-dependent runtime 不能出现在同一个不可部署的中间 SHA：

1. 验证 Wrangler CLI/config 后，扩展 bootstrap、read-only resolve、materialize 和文档；此提交不要求 Worker 使用新 binding。
2. 手动运行 bootstrap，创建或复用 D1/data R2，并取得真实 D1 database ID。
3. 在后续提交加入 migrations、bindings 和 runtime。
4. 部署顺序固定为 resource resolve → D1 remote migration → read/media → sync/Workflow → frontend。

resource resolve 必须在任一 Worker upload 前确认 D1、data R2、image R2、KV 与 Queue 均存在。migration 失败时不得上传任何 Worker。所有 CLI flag、Wrangler config key 和 D1 binding 形态在落盘前都必须由当前安装版本的 `--help`、类型或源码验证。

## 3. D1 权威模型

首版使用五张表且不创建二级索引。当前收藏规模为几百至几千条，全表读取比维护低基数索引产生更少写放大；规模达到数万条时再依据真实 metrics 评估索引。

### 3.1 `collection_items`

建议主键为 `(user_id, subject_id)`，保存：

- bgm.tv 收藏业务字段：collection type、rate、tags、comment、episode/volume progress、上游业务时间。
- 公开投影所需的 subject 标识和规范字段。
- `content_hash`：只覆盖规范业务字段。
- `state_version`：仅用于 D1 乐观并发控制，数据库约束为正整数；初始 insert 必须精确为 `1`，每次实际既有状态 mutation 加一；不进入业务 hash 或公开 snapshot。
- `temperature`：`hot` 或 `cold`。
- `first_seen_at`、`changed_at`、`missing_since`、`deleted_at`。

`last_seen_at`、同步时间、heartbeat、generation 等运行字段不进入 `content_hash`。相同业务输入不得为“更新观察时间”而改写行。

所有既有行 mutation 使用精确 `state_version` compare-and-set。零写结果必须回读当前完整行：既有 mutation 只有与计划最终行完全相等时才作为 response-loss/replay no-op；insert replay 仅额外允许仍处于初始态、全部权威/业务字段相等，且数据库因 `MIN` 保留了不晚于计划值的 `first_seen_at`。其他差异均抛出导出的 `StaleCollectionDiffError`（稳定 code `STALE_COLLECTION_DIFF`）；Task 7 orchestration 只捕获此类型并重新读取 D1、重新规划，禁止继续发布 losing plan，其他 D1/结果验证/JSON 解码错误照常失败。两次并发同步都从“无行”规划 insert 时，仅允许仍处于初始态（`state_version = 1` 且无 missing/deleted）的行按 `(changed_at, content_hash BINARY)` 选择确定性赢家，revision 保持 `1` 并保留最早 `first_seen_at`；一旦发生过状态 transition，延迟 insert 不得清除状态。若同秒没有可恢复的真实先后顺序，content hash 的二进制顺序只用于保证收敛，下一次完整同步会再次校正权威业务状态。

### 3.2 `subject_media`

主键为 `subject_id`，保存：

- detail/media 规范 hash 与公开投影。
- NSFW 状态。
- common/large 源 URL 和现有 image R2 引用。
- `checked_at`、`next_refresh_at`。
- retry 次数、下一次重试时间和脱敏错误分类。

新流程不得写 `subject:detail:*`、`subject:meta:*`、`image:status:*` 或 `subject:refresh:*` 作为权威状态。图片二进制仍写入 `airing-cal-images` 的现有 key。

### 3.3 `sync_runs`

以 instance ID 标识一次运行，保存 status/stage、generation、计数、输入/公开 hash、开始/heartbeat/完成时间和脱敏错误。`0002_sync_run_replay_result.sql` 以 additive migration 增加 `result_json`。Cloudflare D1 的[单个 string/BLOB 与单行上限均为 2,000,000 bytes，SQL statement 上限为 100,000 bytes](https://developers.cloudflare.com/d1/platform/limits/)；因此 `result_json` 只保存小于 100,000 bytes 的 versioned manifest，不内联完整 replay payload。完整 payload 按确定性 `sync:artifact:{instanceId}:{aggregateHash}:{index}` key 分块存入 `app_state`；manifest 绑定 input hash、artifact kind、UTF-8 总字节数、chunk 数、每块 hash 与 aggregate hash。恢复时必须先逐块验证大小、hash、总字节数与 aggregate hash，再解码 collection/prepared schema；所有 manifest/JSON/schema/hash 验证均由 sync lifecycle error boundary 执行，running artifact 损坏必须进入 `failSyncRun`，storage row decoder 不提前解释 payload。

收藏 CAS 与绑定规范输入 hash 的 versioned `collections_pending` manifest 必须在同一个 D1 batch 中提交；其 artifact 保存原始 diff、计数与规范公开输入，因此进程在收藏提交后崩溃时，running replay 重放同一 CAS 并沿用原始结果语义，不根据已变更状态重新计算。若 batch 已提交但响应丢失，只有回读到 status 仍为 running、输入 hash 相同且 `result_json` 与本次规范 manifest 逐字节相同，并成功验证其 artifact，才授权重新执行并 reconcile 完整计划；exact checkpoint 本身不代表多 batch 计划已全部完成。只有完整 `applyCollectionDiff` 返回成功才能进入媒体阶段；缺失或不匹配仍失败。已提交的 prefix 在重放中按 exact no-op 处理，剩余 chunk 继续提交，不重复有害变更。stale CAS 即使同批留下 losing checkpoint，恢复时也必须再次通过完整 CAS/no-op reconciliation，不能直接进入媒体或公开阶段。

收藏阶段成功后、执行任何媒体预算/Queue 外部动作前，系统必须先以 versioned `media_pending` manifest 覆盖 collection checkpoint。该 artifact 内嵌已采用的 collection checkpoint，并冻结规范 `BudgetReservationRequest`、候选计数、逐任务优先级、cold cursor 尾部与 cursor 版本；只有回读确认 `sync_runs.result_json` 精确采用该 manifest 后才允许提交媒体。若 Queue 已接受而进程在 prepared result 落盘前丢失，running replay 必须复用 byte-identical request，而不能重新读取已变化的 `subject_media` 或重新规划；预算 reservation ID 的幂等结果阻止第二次 Queue send，并由冻结的优先级与 cursor 计算同一计数和目标 cursor。

所有 `collections → media_pending → prepared → terminal` transition 都必须以精确 expected stage 与 expected manifest 做 D1 compare-and-set；collection mutation 与 checkpoint CAS 保持同一 batch，guard 失败必须回滚整批。CAS loser 重新加载、校验并沿用 winner artifact，不得以旧 manifest 回退 stage，也不得直接进入失败终态。request 在首次持久化前先经过 canonical JSON round-trip，artifact 与第一次外部提交使用同一个 shaped object，使普通 `JSON.stringify` bytes 在首次与重放间保持一致。request 自带的 `date` 是冻结的审计/fingerprint 字段；预算 reservation 首次创建时必须以协调器权威时钟导出的当前 UTC 日期作为实际 `sync_budget` date，并在同一原子结果中保存，之后重放只返回已存结果。

媒体阶段完成后以 versioned prepared-result manifest 覆盖 `media_pending` 检查点；该 artifact 同时保存目标 cold cursor 与单调版本，并且必须先于 cursor 推进持久化。cursor 通过 `app_state.updated_at` compare-and-set，仅允许更高版本或同版本同值写入，因此旧崩溃实例重放不能覆盖较新实例的全局 cursor。cursor 提交前崩溃时，running replay 幂等补写目标 cursor；cursor 提交后崩溃时，running replay 复用同一 prepared result，不重新规划媒体或重复预算动作。随后 running replay 只补 terminal transition，terminal replay 直接返回同一结果，不重复收藏实际变更、媒体预算或完成动作。

artifact manifest 必须在任何 chunk 写入前完成大小验证；若中途 chunk 写失败，仅对已确认成功写入的 keys 做 best-effort 清理，且清理错误不得覆盖原始写失败。collection apply/adoption 失败时也只清理当前 `sync_runs.result_json` 未引用的新 artifact；删除前必须重新读取 run，若 manifest 仍逐字节相同则拒绝删除。stale artifact chunks 在替代 manifest 成功提交后删除；collection chunks 在 `media_pending` manifest 成功提交后删除，`media_pending` chunks 在 prepared-result manifest 成功提交后删除。

最终 prepared chunks 与对应 `sync_runs` 行保持相同留存期，以保留 terminal exact replay。本 Task 7 没有 sync-run expiry 选择或删除 API，因此不推测 retention 时长，也不删除当前 terminal manifest。artifact codec 提供 `cleanupReplayArtifactIfUnreferenced` 安全 hook：它重新读取对应 run，当前 `result_json` 仍引用候选 manifest 时返回不删除；只有 retention owner 已使 run 不再引用该 manifest 后才删除精确 chunk keys。后续 run-retention 实现负责选择过期 run、在自己的可恢复流程中保留已加载 manifest 直至 hook 成功，并对失败重试；Task 7 负责验证与安全清理机制，不负责 retention policy。运行记录用于健康、审计和 crash-safe replay，不进入公开内容 hash。

### 3.4 `sync_budget`

建议主键为 `(date, resource)`，保存 `reserved`、`consumed` 与更新时间。媒体资源默认 soft limit 50、hard limit 100；只有新增/源变化任务可使用 soft 以上的 privileged headroom。

预算接口接受稳定 reservation ID 和确定性 job 顺序。事务内必须：

1. 检查同一 reservation 是否已存在并返回原结果。
2. 读取当日资源用量。
3. 计算 grant，持久化 reservation 与新用量。
4. 提交后最多尝试一次外部任务投递。

若外部提交结果不确定，reservation 保持占用并标记 `uncertain`，重放不释放、不重发。请求日期只用于 audit/fingerprint；首次 reservation claim 按权威 `now` 的 UTC 日期计费并持久化该 effective date，避免跨日延迟任务回写旧日额度。媒体预算耗尽或提交不确定不阻塞收藏 diff 与 snapshot publication。

### 3.5 `app_state`

以 `key` 为主键并存版本化 JSON，保存：

- 当前/待发布 generation 与 content hash。
- 最后成功 calendar/hash。
- shadow publication 状态。
- 后续 migration/cutover 使用的游标和门禁状态。
- 有界的 sync replay artifact chunks；其生命周期由对应 `sync_runs` manifest 管理。

本 change 不在 `app_state` 中声明已完成 legacy migration 或 read cutover。

## 4. 稳定规范化与收藏 diff

### 4.1 规范 JSON

共享 helper 必须递归稳定排序对象 key、保持数组业务顺序、显式规范化缺失/空值，并以 UTF-8 JSON 计算 SHA-256。禁止依赖运行时对象插入顺序。

`CollectionRow` 的 hash 输入只包含会改变收藏业务或公开 API 结果的字段。以下字段明确排除：

- generation、run/instance ID。
- fetched/published/heartbeat 时间。
- `first_seen_at`、`changed_at`、`missing_since`、`deleted_at` 本身。
- retry、budget 和 migration 状态。

评分、标签、评价、收藏类型和进度即使上游 `updated_at` 未变化也必须被 hash 检出。

### 4.2 每日完整读取与内存 diff

上游没有可靠增量游标，因此 Workflow 完整分页读取所有用户 collections 与 calendar。只有全部 collections 分页和 calendar 成功后，才进入可删除的 diff：

1. 一次读取当前 D1 收藏集合。
2. 规范化上游业务行并建立 `(user_id, subject_id)` map。
3. 新行执行 INSERT。
4. hash 或合法状态变化执行 UPDATE。
5. hash 相同且删除状态未变化时不写。
6. 当前 D1 活跃行第一次缺失时只写 `missing_since`。
7. 下一次成功全量仍缺失时写 `deleted_at`，公开投影移除。
8. 已 missing 的条目重新出现时清除 missing/deleted 状态并按业务 hash 决定是否更新。

任何分页、认证、超时或 calendar 失败都使本轮不推进任何 missing/deleted 状态。已成功获得的局部页不能当作完整集合。

### 4.3 hot/cold 媒体调度

- 新增或源变化：最高优先级，可使用 hard headroom。
- hot 到期：除 `watched` 外的活跃收藏。
- cold shard：`watched` 且 `positiveMod(subject_id, 7) == utcDayShard`。
- retry：只在退避时间到期后进入，优先级低于 cold；到期 retry 不受 cold shard 限制。

同一 subject 只生成一个合并组件任务。存在 retry 状态时，未来退避时间会抑制普通 hot/cold 调度；到期后才按 retry 优先级进入。未到期、URL/hash 未变化的媒体不调度。cold 在预算充足的七个连续 UTC 日中完整覆盖；预算不足时持久化低优先级游标供后续日继续。

成功执行到期 V4 检查后，即使 detail/media 语义内容完全相同，也必须只更新
`checked_at` 和 `next_refresh_at` 调度水位。正常 subject 的下一次 hot 边界沿用
`nextSubjectRefreshAt(subject_id, checked_at)` 的确定性 6～8 天分散规则；
not-found tombstone 沿用 24 小时边界。该 schedule-only mutation 不重写图片 R2
对象或改变 detail/media hash；未到期的相同内容检查仍为 D1/R2 零写。

## 5. 公开 Snapshot 契约

### 5.1 `PublicSnapshotV1`

稳定对象包含：

- `schema_version: 1`
- `generation`
- `content_hash`
- 五类 collections
- calendar
- summary
- 公开图片引用与 NSFW 投影

generation 与发布时间属于 envelope，不参与内容 hash。计算 hash 时使用不含 `generation`、`content_hash` 和发布时间的规范 payload。未知 `schema_version` 必须拒绝。

对象 key：

```text
snapshots/v1/{generation}-{content_hash}.json
```

同一个 key 不覆盖；若对象已存在，内容必须与候选完全一致，否则视为发布冲突。

公开 payload 必须在 collection diff checkpoint 写入前读取一次已提交的
`subject_media`，并将该次观察到的 detail、NSFW 和图片引用冻结进 checkpoint。
collection 与 calendar 使用同一媒体投影：只有
`images/{lowercase-sha256}/original` 形式的 R2 key 才生成
`{ hash, uri: "/image/{hash}", r2_key }`；detail JSON 缺失、无效或 subject ID
不匹配时按字段回退到本轮完整上游数据。有效 tombstone 使用 D1 的 NSFW 状态隐藏
内容，但不删除或丢弃已有合法图片引用。running replay 必须复用 checkpoint 中的
同一公开投影，不能因为稍后媒体任务完成而改变 hash；媒体结果仍只在下一次日同步
进入新 snapshot。

### 5.2 `PublicSnapshotPointerV1`

KV key 固定为 `public:current`，value 只包含：

- `schema_version`
- `generation`
- `content_hash`
- `r2_key`
- `published_at`

pointer 不包含 collections、calendar、summary 或逐 subject 状态。

## 6. Pointer-last 发布协议

一次成功日同步按以下边界执行：

1. D1 transaction 提交收藏 diff、missing/deleted 转换、sync summary 和待发布状态。
2. 从已提交 D1 状态构建规范公开 payload。
3. 读取当前已验证 hash；相同时：
   - 不增加 generation。
   - 不写 R2。
   - 不写 KV pointer。
   - 将 run 标记为成功且 `publication = unchanged`。
4. hash 变化时分配下一个 generation，PUT 不可变 R2 对象。
5. 回读 R2 对象并验证 schema、generation、content hash、对象 key 和规范 payload hash。
6. 仅在验证全部成功后单次 PUT `public:current`。
7. 更新 D1 app state 为已发布并完成 run。

D1、R2 PUT、R2 GET/验证或 KV pointer 任一步失败时，旧 pointer 不变。D1 已提交而发布失败时，保存明确的 pending publication，使 Workflow replay 或下一日能以相同内容重试；不得靠回滚 D1 行恢复。

第一版媒体补全结果不触发同日二次 snapshot。媒体状态更新将在下一次日同步的公开投影中发布。

## 7. Worker 边界

### 7.1 Sync Worker / Workflow

- 完整获取 collections/calendar。
- 调用纯规范化与 diff planner。
- 以有界 D1 batch/transaction 提交变化。
- 仅在 D1-only media Queue producer 可用时原子预留媒体预算并投递确定性 V4 任务；V4 generation 固定为持久化完整输入的 `{ observed_at, run_id }`，其中 `run_id` 是稳定 Workflow instance ID，不使用执行或 retry 的当前时钟。默认 shadow/no Queue 只报告候选与 deferred，不占用正式 D1 预算。既有 live Workflow V3 继续写 legacy KV。
- 构建、验证并 shadow 发布 R2 snapshot/pointer 候选。
- 记录 `sync_runs`，但媒体失败不改变收藏发布结论。

### 7.2 Media Worker

- 仅接受明确的 D1-only V4 任务并从 D1 读取/锁定 subject media 状态；live V3 保留 legacy KV 兼容行为。Subject Durable Object 保留未加前缀的 V2/V3 number generation 围栏，并为 V4 使用独立 `v4:` tuple 围栏；tuple 先按 `observed_at`、再按 `run_id` 排序，两个协议互不推进 obsolete 门槛。
- 获取 detail 和必要图片。
- 相同业务 hash/source/R2 ref 不写 D1、不写图片 R2。
- 新图片继续写现有 `airing-cal-images`。
- 更新 D1 retry/refresh 状态；不写新 legacy per-subject KV。

### 7.3 Read Worker

本 change 仍从 legacy KV snapshot 对外服务。允许加入 D1/data R2 binding 和内部 shadow diagnostics，但不得改变公开 API 响应来源或 fallback 语义。`public:current` 在后续 change 完成一致性门禁前不能成为正式公开读取入口。

## 8. 错误处理、幂等与回滚

- bgm.tv 401/403：run 非重试失败，不推进删除。
- 429、5xx、timeout/network：遵守现有有界重试；最终失败不推进删除。
- D1 constraint/transaction 失败：不发布 R2，不改 pointer。
- R2 PUT/回读失败：记录 pending publication，旧 pointer 继续服务。
- pointer PUT 结果不确定：回读 pointer；只有 value 精确匹配候选才记成功，否则保持可重试状态，不创建另一 generation。
- Workflow replay：稳定 run/reservation ID、规范 hash 和不可变 key 保证不重复预算、不重复对象、不增加 generation。
- 回滚 runtime：部署上一兼容 SHA；D1/R2 新数据保留，不执行破坏性 reverse migration。

任何日志和 health 摘要不得包含 OAuth token、完整上游错误 body 或用户评价正文。

## 9. TDD 与验证计划

### 9.1 Resource/bootstrap

- 先用失败测试定义 D1/R2 create-or-reuse、缺失资源提示、D1 ID materialization 和 migration-before-upload 顺序。
- 使用当前 Wrangler `--help`、类型和源码验证后再实现脚本/config。
- bootstrap 兼容提交推送并在生产创建资源后，才开始 binding-dependent runtime。

### 9.2 D1/state

- migration schema/幂等测试。
- 规范 JSON 与 hash 的 key-order、空值、业务字段和运行字段测试。
- 初次写入、完全相同零写、单字段变化单行写。
- first-missing、second-missing、重新出现、分页失败零删除推进。
- 并发 reservation 只授予最后一个名额一次，重放返回相同结果。

### 9.3 Publication

- 完全相同输入：collection row 0 写、R2 PUT 0、generation 0 增、KV PUT 0。
- 业务变化：只写对应 D1 行、一个 R2 对象、一个 pointer。
- 对 D1 commit、R2 PUT、R2 readback/schema/hash 和 pointer PUT 注入失败，旧 pointer 始终不变。
- replay 和 pointer ambiguous outcome 不产生额外 generation。

### 9.4 Full gates 与生产 shadow

- 相关 package tests、全仓 `pnpm test`、`pnpm typecheck`、`pnpm build:check`。
- OpenSpec strict、`git diff --check`、Wrangler types/dry-run。
- D1 remote migration 与资源 resolve 证据。
- shadow run 对比 legacy snapshot 数量/hash，核对 D1/R2/Queue/KV metrics。

每个 TDD task 必须保留 RED 失败原因与 GREEN 证据，通过独立 spec/quality review 后才勾选、commit 和 push。

## 10. 验收标准

- 相同完整输入不更新 `collection_items`，不写数据 R2，不增加 generation，不更新 `public:current`。
- 评分、标签、评价、收藏状态和进度变化不依赖上游 `updated_at` 即可检出。
- 单次缺失不删除，连续两次成功完整读取缺失才删除；失败分页不推进删除。
- 当日媒体 grant 不超过 hard limit 100；并发和 replay 不超发。
- 新媒体流程不写逐 subject legacy KV。
- R2/pointer 失败继续保留旧公开版本。
- 资源 bootstrap 可重跑，missing resource 与 migration failure 在 upload 前失败。
- 现有公开 API 在本 change 上线后仍从 legacy KV 提供相同响应。
