# Comet Design Handoff

- Change: adopt-d1-r2-incremental-sync
- Phase: design
- Mode: compact
- Context hash: 722984f75288c7f96ea7128784af8c0f46c64ecad1d4d54a328a568c741e291f

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/adopt-d1-r2-incremental-sync/proposal.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/proposal.md
- Lines: 1-31
- SHA256: 8f8aaa349029b95ae6faa710be3b6b2eb826162b487fbab869ddeb572ebe81ad

```md
## Why

止血只能降低当前 KV 写入，无法解决 KV 同时承担权威数据库、运行状态和公开快照所造成的长期写放大风险。系统需要把可变权威状态迁到写额度更充足的 D1，把不可变公开结果发布到独立 R2 数据桶，并将 KV 收缩为极少更新的发布指针。

## What Changes

- 创建或复用 D1 数据库 `airing-cal-state` 与独立 R2 bucket `airing-cal-data`，扩展 bootstrap、resource resolve、Wrangler materialization 和部署 migration 流程。
- 在 D1 建立 collection、subject media、sync run、daily budget 与 app state 五类权威状态。
- 每日完整读取 bgm.tv collections/calendar，在内存计算稳定内容 hash，只写新增、真实变化与确认删除的 D1 行。
- 对上游缺失采用两次成功全量读取确认，任一分页失败时不执行删除判定。
- 将 `watched` 作为 cold，其余收藏状态作为 hot；媒体调度使用优先级与 D1 原子预算预留。
- 生成单个版本化 `PublicSnapshotV1` JSON 到 R2；内容未变化时不写 R2、不增加 generation、不写 KV。
- 使用一次 KV PUT 发布 `PublicSnapshotPointerV1`，并保留旧 KV 读取路径供后续迁移 change 使用。

## Capabilities

### New Capabilities

- `incremental-state-store`: 定义 D1 权威收藏/媒体状态、稳定内容 hash、两次缺失确认和每日 QoS 预算。
- `immutable-public-snapshot`: 定义 R2 `PublicSnapshotV1`、内容寻址 key、校验与 KV pointer 原子发布协议。
- `cloudflare-state-resources`: 定义 D1 与独立 R2 数据桶的 bootstrap、解析、配置 materialization、migration 和部署顺序。

### Modified Capabilities

- `durable-sync-workflow`: Workflow 从版本化 KV staging/publish 改为 D1 增量提交与 R2 不可变发布，同时维持失败保留上一版语义。
- `cache-refresh-lifecycle`: subject media 权威状态与 QoS 从逐 subject KV 生命周期迁至 D1。
- `project-quality-gates`: 增加 D1 migration、R2 发布原子性、零变化零发布和资源配置验证。

## Impact

影响 Cloudflare bootstrap/resolve/deploy 脚本、三个内部 Worker 的 bindings、sync Workflow、media consumer、storage/domain 类型、D1 migrations、R2 snapshot writer、测试和部署文档。公开 HTTP API 暂不切换读取来源；现有图片仍留在 `airing-cal-images`，不复制二进制对象。
```

## openspec/changes/adopt-d1-r2-incremental-sync/design.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/design.md
- Lines: 1-42
- SHA256: ebe35c83815c333be2cb0cdd1a373c80d00670417f4cbe82e8a5fb1b9254c002

```md
## Context

止血后 KV 仍同时承载权威缓存、运行状态、Workflow staging 与公开 snapshot。目标架构以 D1 保存可变状态、R2 保存可重建的不可变公开产物，KV 只保存 active pointer；公开读取切换由后续 change 完成。

## Goals / Non-Goals

**Goals:**

- 建立 D1 权威模型、稳定 diff、两次缺失确认和原子 QoS 预算。
- 内容变化时发布单个可验证 R2 snapshot，并以一次 KV 写切换 pointer。
- 扩展 Cloudflare bootstrap、bindings、migration 与部署门禁。

**Non-Goals:**

- 不切换现有公开 API 的读取来源。
- 不导入或删除 legacy KV metadata。
- 不复制现有图片对象，不做同日媒体完成后的二次发布。

## Decisions

1. D1 使用 `collection_items`、`subject_media`、`sync_runs`、`sync_budget`、`app_state` 五张表且首版不建二级索引；当前数据量全表扫描更省写。
2. 收藏 hash 只覆盖规范业务字段；运行时间与 generation 不参与。每次成功全量读取在内存 diff，只写新增、变化或缺失状态转换。
3. 删除采用两次成功全量读取确认；任何分页失败时不提交删除标记。
4. R2 使用独立 `airing-cal-data` bucket，单对象 key 为 `snapshots/v1/{generation}-{content_hash}.json`。规范 payload hash 未变化时完全不发布。
5. 发布顺序为 D1 commit、R2 put、R2 回读校验、KV pointer put。旧 pointer 始终保持可服务。
6. `sync_budget` 在 D1 事务中预留资源；媒体失败或预算耗尽不得阻塞收藏状态与 snapshot 发布。
7. resource bootstrap 与运行时代码分两次兼容部署；D1 migration 必须先于 read/media/sync Worker 发布。

## Risks / Trade-offs

- [D1 与 R2 在发布窗口短暂不同步] → pointer 最后切换，读取方只接受 pointer 指向且校验通过的对象。
- [全表读取随规模增长] → 当前几千条假设下低于 D1 免费读额度；达到数万条后再以指标决定索引。
- [新资源未 bootstrap 导致部署失败] → resolve job 在上传前失败并给出手动 bootstrap 指令。
- [D1 commit 后 R2 失败] → app state 保留未发布状态，下一轮以相同内容重试，旧 pointer 不变。

## Migration Plan

先提交 bootstrap/resolve 支持并手动创建资源，再提交 schema/bindings 和 migration，随后部署 D1 增量 Workflow 与 shadow R2 writer。旧 KV snapshot 仍是公开读取来源，因此核心回滚只需部署上一兼容 SHA；D1/R2 新数据保留。

## Open Questions

无。
```

## openspec/changes/adopt-d1-r2-incremental-sync/tasks.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/tasks.md
- Lines: 1-34
- SHA256: a864c0847d27938d25c5c5da51ad68eefe7279c9705619c46c74b3c3af467b85

```md
## 1. Resource Bootstrap

- [ ] 1.1 Verify Wrangler D1/R2 CLI and config contracts from help, types and official docs
- [ ] 1.2 Extend manual bootstrap and resource resolve to create/reuse `airing-cal-state` and `airing-cal-data` without changing runtime bindings
- [ ] 1.3 Add D1 ID materialization, tests and documentation, commit/push, then run bootstrap before binding-dependent deployment

## 2. D1 State Model

- [ ] 2.1 Add migrations for collection_items, subject_media, sync_runs, sync_budget and app_state without secondary indexes
- [ ] 2.2 Implement typed D1 adapters, stable canonical JSON/hash helpers and row mapping tests
- [ ] 2.3 Implement atomic daily budget reservation/consumption and concurrency tests

## 3. Incremental Workflow

- [ ] 3.1 Fetch complete collections/calendar and compute in-memory D1 diff that ignores runtime fields
- [ ] 3.2 Implement first-missing and second-successful-missing deletion transitions with pagination-failure protection
- [ ] 3.3 Persist sync summaries and hot/cold media scheduling state without writing new legacy per-subject KV

## 4. Immutable R2 Publication

- [ ] 4.1 Define and validate PublicSnapshotV1/PublicSnapshotPointerV1 and deterministic content hashing
- [ ] 4.2 Implement D1 commit → R2 put → R2 verify → KV pointer publication with no-op hash short circuit
- [ ] 4.3 Add failure-injection and replay tests proving old pointer survival and zero writes on identical input

## 5. Bindings and Deployment

- [ ] 5.1 Add D1 and data R2 bindings to internal Workers while retaining legacy bindings for compatibility
- [ ] 5.2 Apply D1 migrations before Worker deploy and extend config/dry-run/control-plane tests
- [ ] 5.3 Update README, resource tables, architecture, environment variables, deployment and rollback runbooks

## 6. Verification and Shadow Release

- [ ] 6.1 Run package and full repository gates plus Wrangler dry-runs with materialized test IDs
- [ ] 6.2 Deploy D1/R2 core in shadow publication mode, verify resource metrics and commit/push each task atomically
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-15
- SHA256: 05065c51cf1537130c0dc0734d7e5b6d69a01fd1d7c483bc8320e20c64115074

```md
## ADDED Requirements

### Requirement: subject media 权威状态必须存入 D1
系统 MUST 将 detail hash、NSFW、图片源 URL、R2 引用、检查时间、下次刷新时间与退避状态保存在 `subject_media`，新流程不得写逐 subject KV 状态。

#### Scenario: 图片源 URL 未变化
- **WHEN** subject 到期检查返回与 D1 相同的源 URL 和内容 hash
- **THEN** 系统不写图片 R2 对象并只在必要时更新检查调度状态

### Requirement: cold media 必须七日轮转
`watched` subject MUST 作为 cold 按 subject ID 确定性分成七个 shard，其他收藏状态 MUST 作为 hot 按到期时间调度。

#### Scenario: 七个连续日同步
- **WHEN** 预算充足且连续运行七天
- **THEN** 每个 cold subject 恰好至少被选择复查一次
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/cloudflare-state-resources/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/cloudflare-state-resources/spec.md
- Lines: 1-22
- SHA256: 98caaba0b97d1840cd78f05a1a49b11432b675a98426ea5612b4fb763e944874

```md
## ADDED Requirements

### Requirement: 状态资源必须可重复 bootstrap
手动 bootstrap MUST 创建或复用 D1 `airing-cal-state`、R2 `airing-cal-data`、现有图片桶、KV 与 Queue，并返回稳定资源标识。

#### Scenario: 资源已经存在
- **WHEN** 运维再次运行 bootstrap workflow
- **THEN** 系统复用现有资源且不创建同名副本

### Requirement: D1 migration 必须先于 Worker 发布
部署流程 MUST 在 read、media、sync Worker 使用新 binding 前解析 D1 ID 并成功应用 repository migration。

#### Scenario: D1 migration 失败
- **WHEN** migration 命令返回失败
- **THEN** 任一 Worker 上传均不得开始

### Requirement: 缺失资源必须在上传前失败
resource resolve MUST 在任何 deploy 前验证 D1、数据 R2、图片 R2、KV 与 Queue 存在。

#### Scenario: 数据 R2 bucket 尚未 bootstrap
- **WHEN** 自动部署解析不到 `airing-cal-data`
- **THEN** workflow 失败并提示先运行手动 bootstrap
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/durable-sync-workflow/spec.md
- Lines: 1-15
- SHA256: 4d1d32fabe8451be9cadf2c90b37d899bfbf9a464ea669405f732667f3909ad9

```md
## ADDED Requirements

### Requirement: Workflow 必须增量提交 D1 状态
Workflow MUST 在成功获取全部 collections 与 calendar 后对 D1 当前状态执行内存 diff，并只提交新增、真实变化与合法状态转换。

#### Scenario: 业务内容完全相同
- **WHEN** 每日全量读取成功且所有规范 hash 与 D1 相同
- **THEN** collection_items 产生零行写入且 Workflow 仍记录成功摘要

### Requirement: Workflow 必须发布可验证 R2 候选
Workflow MUST 在 D1 状态提交后构建 `PublicSnapshotV1`，并仅在内容 hash 变化时执行 R2 与 pointer 发布协议。

#### Scenario: D1 成功但 R2 写入失败
- **WHEN** 新公开内容已提交到 D1而 R2 PUT 失败
- **THEN** Workflow 记录可重试错误且旧 KV pointer 不变
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/immutable-public-snapshot/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/immutable-public-snapshot/spec.md
- Lines: 1-22
- SHA256: 53d1637cc98c34d3406f0660c280855903206f455b789e9b744d474e9fceb59e

```md
## ADDED Requirements

### Requirement: 公开 snapshot 必须是不可变单对象
系统 MUST 将完整 collections、calendar 与 summary 作为 `PublicSnapshotV1` 写入 `snapshots/v1/{generation}-{content_hash}.json`。

#### Scenario: 公开内容发生变化
- **WHEN** D1 commit 后规范公开 payload hash 不同于当前版本
- **THEN** 系统写入一个新 R2 对象且不覆盖旧 generation

### Requirement: 未变化内容必须零发布写入
系统 MUST 排除 generation 与发布时间后计算规范 content hash；hash 相同时不得写 R2、增加 generation 或更新 KV pointer。

#### Scenario: 无变化日同步
- **WHEN** 收藏、calendar 与公开媒体投影均与当前 snapshot 相同
- **THEN** R2 PUT 与 KV PUT 均为零

### Requirement: pointer 必须最后原子切换
系统 MUST 在 D1 commit、R2 PUT 与 R2 回读校验全部成功后，以单次 KV PUT 更新 `public:current`。

#### Scenario: R2 回读校验失败
- **WHEN** 新对象的 schema、generation 或 hash 与候选 pointer 不一致
- **THEN** 当前 pointer 保持不变且旧 snapshot 继续可用
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/incremental-state-store/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/incremental-state-store/spec.md
- Lines: 1-29
- SHA256: fedd4df29f842fe7152b47db6842c00a1c94d58b166147aaa15dd427552cf6cd

```md
## ADDED Requirements

### Requirement: D1 必须保存可变权威状态
系统 MUST 在 D1 保存收藏、subject media、sync run、每日预算与 app state，且 KV 不得继续作为这些状态的新写入权威来源。

#### Scenario: 首次成功全量同步
- **WHEN** D1 尚无收藏且 bgm.tv 返回完整 collections
- **THEN** 系统写入规范 collection rows、稳定 content hash 与 hot/cold temperature

### Requirement: 收藏 diff 必须忽略运行字段
系统 MUST 仅对影响公开业务结果的规范字段计算 content hash；generation、同步时间与 heartbeat 不得造成内容变化。

#### Scenario: 连续两日业务内容相同
- **WHEN** 第二日上游返回相同业务字段但同步时间不同
- **THEN** collection_items 产生零行更新

### Requirement: 删除必须经过两次成功读取确认
系统 MUST 在第一次完整读取缺失时记录 missing state，只有下一次完整读取仍缺失时才确认删除；分页失败不得推进删除状态。

#### Scenario: 上游暂时漏页
- **WHEN** 一轮 collection 分页最终失败
- **THEN** 系统不新增 missing 标记也不确认任何删除

### Requirement: QoS 预算必须原子预留
系统 MUST 在 D1 中按日期与资源原子预留、消费每日预算，并在不足时延后低优先级工作。

#### Scenario: 两个 consumer 并发申请最后一个名额
- **WHEN** 两个请求同时申请只剩一个的媒体预算
- **THEN** 恰好一个申请成功且总消费不超过 hard limit
```

## openspec/changes/adopt-d1-r2-incremental-sync/specs/project-quality-gates/spec.md

- Source: openspec/changes/adopt-d1-r2-incremental-sync/specs/project-quality-gates/spec.md
- Lines: 1-15
- SHA256: e9c47a8e4b79c0a4651b69e57614e4b95e6c1bac54d8e094ff50f3d8b8d02ef2

```md
## ADDED Requirements

### Requirement: D1 与 R2 发布链路必须自动验证
质量门禁 MUST 覆盖 migration、稳定 hash、零变化零写入、两次删除确认、原子预算与 R2 pointer 最后切换。

#### Scenario: 重放相同每日同步
- **WHEN** 测试以相同输入连续运行两次
- **THEN** 第二次不写 collection row、R2 snapshot 或 KV pointer

### Requirement: 部署配置必须解析全部状态资源
CI MUST 验证 D1 ID materialization、两个 R2 bucket bindings 与 migration-before-deploy 顺序。

#### Scenario: D1 placeholder 未替换
- **WHEN** dry-run config 仍包含 D1 database ID placeholder
- **THEN** 配置检查失败且不运行 Worker deploy
```

