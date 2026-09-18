# Comet Design Handoff

- Change: migrate-data-plane-to-vps
- Phase: design
- Mode: compact
- Context hash: 47c961d397304cc10cc6922e6c82747e031c0f846d579ae0db2f8b753835229e

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/migrate-data-plane-to-vps/proposal.md

- Source: openspec/changes/migrate-data-plane-to-vps/proposal.md
- Lines: 1-38
- SHA256: 14ffb0c455a9d07ff8b6aa8a499018d6dca6be18c14959ff5d7d20664f51151f

```md
## Why

Cloudflare Free Plan limits now shape the data pipeline more than the product requirements: routine synchronization depends on four Workers plus Workflow, Queue, Durable Objects, D1, KV, and two R2 buckets. Moving write-side processing to an existing VPS and provider-neutral PostgreSQL removes those quota-driven coordination paths while retaining Cloudflare's useful public-read and CDN boundary.

## What Changes

- Add a one-shot TypeScript synchronization runtime executed from Docker Compose by a VPS host cron, with PostgreSQL advisory locking and durable run records.
- Replace D1/KV/Workflow/Queue authority with provider-neutral PostgreSQL reached only through `DATABASE_URL`; tokens and infrastructure credentials remain runtime secrets.
- Publish canonical, immutable public snapshots to R2 and switch `public/manifest.json` only after upload and hash verification; unchanged content performs no publication.
- Change the Read Worker to load and validate the R2 manifest and snapshot, then fall back to its last verified Cache API copy and, during migration, the legacy KV source.
- Add post-publication PostgreSQL backups to private R2 storage, an explicit retention policy, and a tested restore path.
- Send a sanitized Feishu webhook result for every scheduled run, including no-change, partial-success, and failure outcomes.
- Add minimal Alpine-based production and opt-in debug container targets, Docker Compose deployment assets, and GHCR workflows that publish immutable git-SHA tags.
- Freeze `harden-workflow-request-budget`, `adopt-d1-r2-incremental-sync`, and the remaining production gates in `migrate-public-reads-from-kv`; their Cloudflare write-path work is superseded but their verified snapshot/read behavior remains implementation evidence.
- **BREAKING**: after the staged cutover and observation gates, routine synchronization no longer runs through Cloudflare Workflow, Queue, Durable Objects, D1, or KV write paths.

## Capabilities

### New Capabilities

- `vps-data-sync-runtime`: One-shot scheduled synchronization, complete-input gating, bounded retry, concurrency exclusion, and durable run outcomes on the VPS.
- `postgres-authoritative-state`: Provider-neutral PostgreSQL schema, migrations, transactions, collection/media/calendar authority, and publication metadata.
- `r2-snapshot-publication`: Canonical snapshot hashing, immutable R2 objects, monotonic generation, verified manifest switching, and no-change publication behavior.
- `postgres-r2-backup`: Post-publication custom-format database backups, private R2 manifests, retention, and restoration verification.
- `sync-run-notifications`: Sanitized Feishu notifications for every terminal synchronization outcome without coupling notification delivery to publication success.
- `vps-container-delivery`: Minimal Alpine production/debug images, hardened one-shot Compose execution, immutable GHCR SHA delivery, and manually approved VPS rollout.

### Modified Capabilities

- `durable-sync-workflow`: Replace Cloudflare Workflow/Cron/Queue orchestration requirements with the VPS one-shot runtime while preserving complete-input, replay safety, monotonic publication, and observability guarantees.
- `cache-refresh-lifecycle`: Replace Queue and Durable Object media serialization with PostgreSQL-owned refresh state and synchronization-run concurrency control while preserving stale-serving and no-op behavior.
- `public-read-contracts`: Make the verified R2 manifest/snapshot the primary public source without changing existing public URL or response contracts.
- `project-quality-gates`: Add PostgreSQL integration, snapshot failure injection, backup restoration, container-content, Compose hardening, Feishu redaction, and GHCR reproducibility gates; retire write-path-specific Cloudflare deployment gates after cutover.
- `sync-consistency`: Preserve all-or-nothing collection/calendar publication and deletion safety across the PostgreSQL transaction and R2 publication boundary.

## Impact

The change adds a VPS synchronization application, PostgreSQL migrations/adapters, R2 publisher and backup modules, Feishu notification support, Docker/Compose assets, and GHCR workflows. It modifies the existing Read Worker and shared domain/storage contracts, and later removes routine deployment of the Cloudflare sync/media write path. The public frontend routes and response shapes remain compatible. Database provider selection, automatic SSH deployment, public VPS endpoints, real-time refresh, frontend redesign, and automatic Cloudflare resource deletion are out of scope.
```

## openspec/changes/migrate-data-plane-to-vps/design.md

- Source: openspec/changes/migrate-data-plane-to-vps/design.md
- Lines: 1-53
- SHA256: 76b7b2776ca274b099ba1a1caae3f5916a87e10f249ffd2191f8ea1da2ba9d32

```md
## Context

The deployed data path is optimized around Cloudflare Free Plan quotas rather than the application's low-frequency, read-mostly workload. The repository already contains reusable TypeScript API/domain logic and a verified R2 snapshot reader, while the write path is split across Workflow, Queue, Durable Objects, D1, KV, and R2. The target keeps Cloudflare in the public request path but makes an existing VPS the only scheduled compute node and an interchangeable hosted PostgreSQL database the authority.

## Goals / Non-Goals

**Goals:**

- Run complete, observable, mutually exclusive data synchronization as a one-shot VPS container.
- Keep PostgreSQL provider-neutral and keep all public requests independent of the VPS/database.
- Publish immutable, content-verified R2 snapshots through a monotonic manifest.
- Back up PostgreSQL to private R2 and notify Feishu after every run.
- Deliver minimal Alpine production and opt-in debug images through immutable GHCR SHA tags.
- Preserve public routes and response shapes during a staged, reversible cutover.

**Non-Goals:**

- Hosting a public frontend or API on the VPS.
- Cloudflare-to-PostgreSQL connections, provider-specific database SDKs, or real-time refresh.
- GitHub Actions SSH deployment, automatic deletion of existing Cloudflare resources, or frontend redesign.

## Decisions

1. A host cron invokes `docker compose run --rm sync`; the container is one-shot and takes a PostgreSQL advisory lock. This avoids another scheduler container and makes overlapping manual/scheduled runs safe. A continuously running service was rejected because there is no public request workload.
2. PostgreSQL is addressed only by `DATABASE_URL`, uses versioned SQL migrations, and owns collection, calendar, media, run, and publication state. D1/KV adapters remain only for migration fallback until cutover. A provider SDK was rejected to keep Neon, Supabase, and ordinary PostgreSQL interchangeable.
3. Publication writes canonical JSON to `snapshots/v1/<generation>-<sha256>.json`, verifies it by readback, and only then replaces `public/manifest.json`. Identical content is a no-op. Directly overwriting one snapshot object was rejected because it prevents immutable caching and safe rollback.
4. The Read Worker validates manifest schema, monotonic generation, key shape, and content hash. It falls back to its last verified Cache API object and then legacy KV during migration. The browser never receives storage/database credentials.
5. A successful publication is followed by custom-format `pg_dump` to private R2. Backup failure yields partial success and never rolls back a public snapshot. Retention keeps 30 daily backups plus the last backup of each month.
6. Feishu notification is a terminal side effect for every run. Notification failure is persisted but cannot change database/publication outcome. Messages contain only sanitized summaries.
7. The Dockerfile uses official floating `node:alpine` inputs as explicitly requested, records resolved Node/Alpine/base digest metadata, and publishes immutable git-SHA GHCR outputs. The production target contains only runtime requirements; a manually triggered `-debug` target adds verified diagnostic packages.
8. Deployment remains manual on the VPS: operators update Compose to a full GHCR SHA, pull, run a shadow sync, and then approve cutover. This keeps first-release credentials and rollback outside GitHub Actions.

## Risks / Trade-offs

- [A floating Alpine/Node build input can change without source changes] → Record the resolved digest and never overwrite an existing GHCR SHA image; base refreshes produce a new reviewed commit/image.
- [Hosted PostgreSQL cold start or network failure] → Use bounded retry and fail before publication; the previous R2 manifest remains active.
- [PostgreSQL commit and R2 publication are not one transaction] → Persist pending publication metadata and make upload/verification/manifest switching replay-safe.
- [VPS compromise exposes write credentials] → Use least-privilege database/R2 credentials, a private env file, non-root/read-only containers, and no public ports.
- [R2 backup shares the Cloudflare administrative boundary] → Keep backups private, verify checksums/restores, and retain PostgreSQL provider restore features as a second recovery path.
- [Legacy Cloudflare state drifts during shadowing] → Compare normalized public payloads for three successful runs and retain the old path throughout cutover observation.

## Migration Plan

1. Build the PostgreSQL/VPS path and publish only shadow snapshots while the current Cloudflare path remains live.
2. Complete at least three successful normalized comparisons and one restore drill.
3. Manually switch `public/manifest.json`; retain Cache API and legacy KV fallback.
4. Observe seven days, then disable old Cron/Workflow/Queue consumers without deleting data.
5. Retain old Cloudflare data resources for at least 30 days; cleanup requires a separate approval.
6. Rollback by restoring the previous manifest or returning the Read Worker to legacy mode; never reverse PostgreSQL migrations or delete R2 generations during rollback.

## Open Questions

None. The hosted PostgreSQL vendor remains an operational selection because the runtime contract is the standard `DATABASE_URL`.
```

## openspec/changes/migrate-data-plane-to-vps/tasks.md

- Source: openspec/changes/migrate-data-plane-to-vps/tasks.md
- Lines: 1-46
- SHA256: 0cd5aa20ed1ca857c33e3e946a1c2458dc2d594c2190e53e323512ff49def018

```md
## 1. PostgreSQL Authority

- [ ] 1.1 Verify PostgreSQL client/migration APIs, add the VPS application package, and implement versioned schema migrations plus advisory-lock tests using TDD
- [ ] 1.2 Implement provider-neutral repositories for collection, calendar, media, sync-run, and publication state with transaction, deletion-safety, replay, and secret-persistence tests

## 2. VPS Synchronization Runtime

- [ ] 2.1 Reuse the verified bgm.tv client/domain logic to implement complete collection/calendar input, bounded retry, primary failure protection, and normalized diff tests
- [ ] 2.2 Implement the one-shot run coordinator, heartbeat/terminal outcomes, no-change behavior, media refresh lifecycle, and concurrent-run exclusion with RED-to-GREEN tests

## 3. Immutable R2 Publication

- [ ] 3.1 Define PublicSnapshotManifestV1 and canonical snapshot hashing, key validation, generation allocation, and identical-content no-op tests
- [ ] 3.2 Implement snapshot upload, readback verification, replay-safe pending publication, final manifest switching, and failure-injection tests

## 4. Cloudflare Read Cutover

- [ ] 4.1 Add R2 manifest/snapshot validation to the Read Worker while preserving public response shapes and parameter contracts
- [ ] 4.2 Implement fallback order R2 to last verified Cache API to migration-period legacy KV, including corrupt, missing, rollback-generation, and VPS-offline tests

## 5. Backup and Restore

- [ ] 5.1 Verify pg_dump/pg_restore and R2 client contracts, then implement custom-format backup upload, checksum manifest, partial-success semantics, and tests
- [ ] 5.2 Implement explicit 30-daily/monthly retention selection and an empty-database restore verification command with non-destructive key and recovery tests

## 6. Feishu Run Notifications

- [ ] 6.1 Verify the official Feishu webhook/signature contract and implement success, no-change, partial, failure, and skipped notification payload tests
- [ ] 6.2 Implement bounded notification delivery, notification_failed persistence, previous-failure summary, and credential/error redaction tests

## 7. Alpine Container and VPS Operation

- [ ] 7.1 Verify official node:alpine metadata and Alpine package names, then add multi-stage production/debug Docker targets with image-content and non-root/read-only runtime checks
- [ ] 7.2 Add SHA-pinned one-shot Docker Compose configuration, secret template, writable temporary boundary, host-cron/flock example, and local shadow-run instructions

## 8. GHCR Delivery

- [ ] 8.1 Verify GitHub Actions and GHCR contracts, then add production image CI with test gates, resolved Node/Alpine/base-digest metadata, immutable full-SHA tags, and non-overwrite enforcement
- [ ] 8.2 Add manual debug-image workflow publishing only `<git-sha>-debug`, and verify production Compose cannot select floating or debug tags

## 9. Documentation, Verification, and Cutover

- [ ] 9.1 Synchronize README, architecture, environment variables, database migrations, snapshot/backup/notification, VPS deployment, restore, rollback, and old-change supersession documentation with each code task
- [ ] 9.2 Run full repository, PostgreSQL integration, R2 failure-injection, container, Compose, GHCR-equivalent, OpenSpec strict, and documentation audit gates and record a verification report
- [ ] 9.3 Run at least three VPS shadow comparisons and one backup restore drill, then perform an explicitly approved manifest cutover and observe seven days before disabling old Cloudflare schedulers
- [ ] 9.4 Retain legacy Cloudflare data resources for at least 30 days and require a separate approval/change before any resource cleanup
```

## openspec/changes/migrate-data-plane-to-vps/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-90
- SHA256: cef06087e2b82d12cf8709df44126469b32e45e30d9f424e8cf3009a3260899b

[TRUNCATED]

```md
## ADDED Requirements

### Requirement: 媒体生产者必须唯一
VPS 同步运行时 MUST 是 detail、metadata、image 与 R2 图片对象的唯一正式生产者；Cloudflare Read Worker MUST 只读取 snapshot 与内容寻址图片，不得抓取上游、更新 PostgreSQL 或写入图片对象。

#### Scenario: 图片未命中公开缓存
- **WHEN** Read Worker 收到一个有效 snapshot 图片 URI 且边缘缓存未命中
- **THEN** Read Worker 仅从 R2 读取内容并返回缓存响应，不调用 bgm.tv 或产生 R2 PUT

#### Scenario: 从 shadow 切换到 live
- **WHEN** VPS shadow 验证通过并准备成为正式媒体生产者
- **THEN** 旧 Cloudflare Media Queue consumer 在 live 切换前停止，避免出现两个正式写者

## MODIFIED Requirements

### Requirement: subject 缓存必须支持过期继续服务
subject detail、metadata 或 image 到期时，公开读取 MUST 继续服务 PostgreSQL/R2 中最后成功版本，VPS 同步任务在后台刷新且失败不得清空旧值。

#### Scenario: detail 已进入刷新窗口
- **WHEN** subject detail 已到刷新时间但仍有上次成功值
- **THEN** 公开 snapshot 继续包含旧值且本轮任务尝试刷新

### Requirement: subject 刷新时间必须分散
系统 MUST 使用 subject ID 与稳定周期计算确定性刷新分片，避免单次日任务同时刷新所有稳定 subject。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个 subject 首次进入 PostgreSQL
- **THEN** 后续刷新时间按稳定分片分散而不是全部同日到期

#### Scenario: subject 尚未到期
- **WHEN** 已缓存 subject 内容未变化且刷新时间未到
- **THEN** 同步任务不调用对应上游详情或图片接口

### Requirement: Media Queue 消息必须可去重
每个媒体刷新 MUST 由稳定 run ID、subject ID 与观察时间标识；PostgreSQL 唯一约束和状态转换 MUST 阻止重放产生重复下载或 R2 写入。

#### Scenario: 同一 run 重放
- **WHEN** 同一 subject 的媒体阶段因任务恢复再次执行
- **THEN** 已完成状态被复用且不重复下载或覆盖图片

### Requirement: 刷新状态与图片结果必须分离
系统 MUST 在 PostgreSQL 分别保存 detail、metadata、image 与 refresh 结果；缺少图片 URL 不得把成功 metadata 标记失败。

#### Scenario: metadata 成功但图片缺少源 URL
- **WHEN** subject metadata 可用而图片 URL 缺失
- **THEN** metadata 被提交且 image 状态记录为明确缺失

### Requirement: Media Queue 重试必须区分瞬态与终态
VPS 媒体刷新 MUST 区分可重试网络/上游错误与 404 等终态，并使用持久化 next_retry_at 防止每轮无界重试。

#### Scenario: 图片上游暂时返回 503
- **WHEN** 图片下载返回 503
- **THEN** 旧图片继续服务且记录有界退避时间

#### Scenario: subject 不存在
- **WHEN** bgm.tv 明确返回 404
- **THEN** 系统记录保守 tombstone 且不按瞬态错误立即重试

### Requirement: subject 副作用必须按 generation 串行
系统 MUST 使用 PostgreSQL advisory/row lock 和观察时间围栏串行执行同一 subject 的 detail、metadata、image 与 refresh 副作用，并拒绝过期写入。

#### Scenario: 旧刷新晚完成
- **WHEN** 较旧 observed_at 的刷新在较新状态提交后返回
- **THEN** 旧结果标记 obsolete 且不得覆盖 PostgreSQL 或 R2

#### Scenario: 迁移期旧 Worker 与 VPS 共存
- **WHEN** shadow 期间旧媒体 Worker 仍可能运行
- **THEN** VPS shadow 不切换公开 manifest，切流前停止旧 consumer 以建立单一写者

### Requirement: subject 404 必须建立保守 tombstone
确认 subject 404 后 PostgreSQL MUST 保存有期限 tombstone；网络错误不得创建 tombstone，期限内不得重复抓取。

#### Scenario: 已缓存 subject 后变成 404
- **WHEN** 权威详情接口明确返回 404
- **THEN** 系统保留最后成功公开数据并记录 tombstone 到期时间

#### Scenario: tombstone TTL 内再次同步
- **WHEN** 下一轮任务发生在 tombstone 到期前
- **THEN** 系统不重复请求该 subject 详情

```

Full source: openspec/changes/migrate-data-plane-to-vps/specs/cache-refresh-lifecycle/spec.md

## openspec/changes/migrate-data-plane-to-vps/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/durable-sync-workflow/spec.md
- Lines: 1-76
- SHA256: 90a09993359fbd2d696142c384b86fa0a0d19334f6e290aa3c4ea2e716580f4c

```md
## MODIFIED Requirements

### Requirement: 获取失败必须保留上一版正式快照
collections 或 calendar 获取最终失败时，VPS 同步任务 MUST 记录失败终态并保留上一版 PostgreSQL 权威数据和 R2 manifest。

#### Scenario: calendar 重试耗尽
- **WHEN** 收藏已完整获取但 calendar 最终失败
- **THEN** 任务以 failed 退出且不提交权威事务或公开 snapshot

### Requirement: Workflow 网络错误必须分类重试
同步运行时 MUST 将 401/403 视为终态认证错误，将 429、5xx、timeout 与网络错误按有界策略重试，并在耗尽后保留上一版公开数据。

#### Scenario: 上游鉴权失败
- **WHEN** bgm.tv 返回 401 或 403
- **THEN** 当前网络操作不重试且 run 记录脱敏认证错误

#### Scenario: 上游限流
- **WHEN** bgm.tv 返回 429
- **THEN** 当前网络操作按配置重试且不得覆盖上一版 manifest

### Requirement: Workflow 状态必须可观测
系统 MUST 在 PostgreSQL 持久化当前和最近同步 run 的阶段、心跳、终态、计数、耗时、git SHA 与脱敏错误，并由 health API 以兼容结构暴露应用状态。

#### Scenario: heartbeat 过期
- **WHEN** running run 超过约定窗口未更新 heartbeat
- **THEN** health 将其标记 stale 且保留 run ID 供 VPS 日志核对

#### Scenario: 初始化后尚未完成
- **WHEN** run 已获得 advisory lock 但尚未 finalize
- **THEN** health 可定位该 run 并返回其最后持久化阶段

### Requirement: live generation 必须单调提交
系统 MUST 使用 PostgreSQL 锁和 publication 状态单调分配 generation；只有完成 R2 snapshot 上传与回读验证的 run 才能切换 manifest。

#### Scenario: 较旧运行晚完成
- **WHEN** generation 1 在 generation 2 已切换后尝试发布
- **THEN** generation 1 返回 obsolete 且 manifest 仍指向 generation 2

#### Scenario: publication 中途失败
- **WHEN** snapshot 上传或回读校验失败
- **THEN** 本次 generation 不得成为公开 manifest

### Requirement: 定时同步必须按日运行
系统 MUST 使用 VPS 宿主机 cron 在每天 04:00 Asia/Shanghai 启动一次 Compose sync 任务，且不得保留 Cloudflare Worker Cron 作为常规业务调度源。

#### Scenario: 一个完整自然日
- **WHEN** VPS cron 正常运行
- **THEN** 系统只尝试一个 scheduled sync run，重叠触发由双层锁跳过

### Requirement: 未变化同步不得产生逐 subject 副作用
同步任务 MUST 在写入和媒体获取前筛除规范状态未变化且未到刷新时间的 subject；仅 run 状态与必要备份可更新。

#### Scenario: 所有 subject 稳定且未到期
- **WHEN** 每日任务完成 collections 与 calendar 抓取
- **THEN** 不产生逐 subject 数据更新或重复 R2 图片写入，公开 manifest 保持不变

### Requirement: 同步运行指标必须闭合
系统 MUST 分别记录 fetched、inserted、updated、confirmed_deleted、unchanged、media refreshed/failed、publication、backup 与 notification 结果；不得把计划数量标记为已完成副作用。

#### Scenario: backup 失败
- **WHEN** 数据与 snapshot 成功而 backup 失败
- **THEN** run 聚合计数保持实际完成值并以 partial 终态结束

## REMOVED Requirements

### Requirement: 同步必须由可恢复 Workflow 编排
**Reason**: Cloudflare Workflow 不再承载周期同步；恢复与重放由 PostgreSQL run/publication 状态和幂等的一次性 VPS 任务承担。
**Migration**: 使用 `vps-data-sync-runtime` 的 advisory lock、run 状态和 replay-safe publication。

### Requirement: Workflow step 必须确定且有界
**Reason**: VPS 任务不受 Worker invocation subrequest 限制，不再需要 Workflow step/staging 拆分。
**Migration**: 保留完整分页、有界重试和事务提交要求，但在单次容器运行中执行。

### Requirement: shadow 与 live 发布必须隔离
**Reason**: Cloudflare Workflow mode 被移除。
**Migration**: VPS CLI/配置提供 shadow publication，shadow 只生成比较对象且不得切换 `public/manifest.json`。
```

## openspec/changes/migrate-data-plane-to-vps/specs/postgres-authoritative-state/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/postgres-authoritative-state/spec.md
- Lines: 1-22
- SHA256: 4ce1511c72b946d483f582ba1e2a0be86d4e83e4f79f226a42239d83040831fb

```md
## ADDED Requirements

### Requirement: 权威状态必须使用标准 PostgreSQL 契约
系统 MUST 仅通过 TLS `DATABASE_URL` 访问 PostgreSQL，并使用版本化 SQL migrations 管理 collection、subject media、calendar、sync run、publication 和 migration 状态，不得依赖供应商专有 API。

#### Scenario: 更换托管 PostgreSQL 供应商
- **WHEN** 运维导入标准 PostgreSQL dump 并替换 `DATABASE_URL`
- **THEN** 同步程序无需代码或 schema 变更即可运行

### Requirement: 完整数据变更必须事务提交
系统 MUST 在完整输入验证通过后于单个事务内应用新增、真实更新和确认删除，并不得持久化 Bangumi token、飞书 Webhook 或 R2 credential。

#### Scenario: transaction 提交前异常
- **WHEN** collection 已写入但 calendar 写入失败
- **THEN** 整个权威状态事务回滚且上一版数据保持不变

### Requirement: 删除必须以完整观测为前提
系统 MUST 仅在目标账户全部分页和 calendar 成功获取后确认缺失记录；截断或空页异常不得转化为删除。

#### Scenario: 未达到 total 时返回空页
- **WHEN** 已读取数量小于 total 而上游返回空 data
- **THEN** 本轮失败且数据库中既有收藏不得被删除
```

## openspec/changes/migrate-data-plane-to-vps/specs/postgres-r2-backup/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/postgres-r2-backup/spec.md
- Lines: 1-22
- SHA256: 5ebf320bb19dfdae9fd9ffc770314cfb8965f1fc68f50b19159cf491d1ec436b

```md
## ADDED Requirements

### Requirement: 发布后必须生成可恢复数据库备份
系统 MUST 在成功发布或确认 no-change 后生成 PostgreSQL custom-format dump、校验摘要和备份 manifest，并上传到私有 R2 backup prefix。

#### Scenario: 完整同步成功
- **WHEN** 权威事务和 publication 阶段完成
- **THEN** 系统上传可由标准 PostgreSQL 工具恢复的 dump 与对应 manifest

### Requirement: 备份失败不得撤销发布
备份属于 publication 后阶段；失败 MUST 令 run 成为 partial，但不得回滚数据库或已切换的公开 manifest。

#### Scenario: R2 backup 上传超时
- **WHEN** snapshot 已发布而 dump 上传重试耗尽
- **THEN** 公开版本继续服务且通知明确报告 backup failed

### Requirement: 备份保留与恢复必须可验证
系统 MUST 保留最近 30 个每日备份和每月最后一个归档，只删除显式枚举且确认过期的 key，并提供恢复到空数据库的校验流程。

#### Scenario: 执行恢复演练
- **WHEN** 运维下载一个保留中的 dump 并恢复到空库
- **THEN** schema、核心行数和重新生成的 snapshot hash 均通过校验
```

## openspec/changes/migrate-data-plane-to-vps/specs/project-quality-gates/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/project-quality-gates/spec.md
- Lines: 1-54
- SHA256: b8a3af9ac5ac10f1dd9e9cdabb2313eddb9c23629351321cd0eae55743f3011d

```md
## MODIFIED Requirements

### Requirement: 高风险逻辑必须有自动检查
完整输入、删除保护、PostgreSQL transaction/advisory lock、R2 幂等发布、manifest 验证、备份恢复、飞书脱敏、容器加固、公开输出编码、严格查询参数和管理写入 MUST 有可运行自动测试。

#### Scenario: publication 重放
- **WHEN** 测试对相同 content hash 重放 publication
- **THEN** 不增加 generation、不重复上传 snapshot 且 manifest 保持不变

#### Scenario: 恶意数据进入公开 HTML
- **WHEN** 测试注入脚本标签、事件属性和 pre 结束标签
- **THEN** 输出不可执行且安全响应头完整

### Requirement: 类型和部署产物必须可验证
每次部署前 MUST 完成 TypeScript typecheck、自动测试、Read Worker Wrangler dry-run、production/debug image build 和 Compose config 校验；生产 image 内容与运行身份 MUST 通过自动审计。

#### Scenario: debug 工具进入 production image
- **WHEN** production image 包含仅允许在 debug target 的 package
- **THEN** CI 失败且不得推送 production SHA tag

### Requirement: CI 工具版本必须可复现
仓库依赖与 pnpm MUST 使用已声明版本；浮动 `node:alpine` 构建 MUST 记录实际 Node、Alpine 和 base digest，GHCR SHA tag MUST 不可覆盖。

#### Scenario: node:alpine 指向新 digest
- **WHEN** CI 解析到不同 base digest
- **THEN** 构建元数据记录差异且旧 git-SHA image 不被覆盖

### Requirement: 文档必须通过实现核对
README、技术设计和 runbook MUST 与 VPS cron、Compose SHA、PostgreSQL migrations、R2 manifest/backup、飞书通知、Cloudflare read bindings 和当前切流阶段一致，不得把未启用的未来路径描述为已上线。

#### Scenario: 仍声明 Cloudflare Workflow 为生产调度源
- **WHEN** VPS 切流已完成且文档审计发现旧声明
- **THEN** 发版门禁失败直到文档与运行状态一致

### Requirement: 部署不得等待业务同步
CI/CD MUST 构建、测试并发布代码/image，但不得连接生产数据库、触发正式同步、修改 R2 manifest 或等待业务数据收敛。

#### Scenario: GHCR production image 发布完成
- **WHEN** image push 成功
- **THEN** workflow 结束且 VPS 继续运行人工批准的既有 SHA

### Requirement: 回退步骤必须可执行且保留数据
runbook MUST 记录以不可变 GHCR SHA、上一 R2 manifest 和 legacy read mode 回退的流程；回退不得 reverse PostgreSQL migration 或删除 PostgreSQL/R2/Cloudflare 数据。

#### Scenario: 新 manifest 发布异常
- **WHEN** 运维决定回退公开读取
- **THEN** 恢复上一已验证 manifest 或 legacy mode，并保留新数据库行和 snapshot 供调查

### Requirement: 写放大必须有自动回归门禁
质量门禁 MUST 验证大批量未变化 subject 不产生逐 subject PostgreSQL UPDATE、图片 PUT 或新 snapshot/manifest。

#### Scenario: 稳定 subject 回归样例
- **WHEN** 测试运行完整每日同步且所有内容未变化、未到刷新时间
- **THEN** 仅允许 run/backup/notification 状态变化，业务行与公开 manifest 无写入
```

## openspec/changes/migrate-data-plane-to-vps/specs/public-read-contracts/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/public-read-contracts/spec.md
- Lines: 1-19
- SHA256: fa9f273b8890522f1d49e896a22ded3eef42035063651cf7722a83c7be05fd8a

```md
## ADDED Requirements

### Requirement: 公开读取必须验证 R2 manifest 与 snapshot
Read Worker MUST 读取 `public/manifest.json`，验证 schema、单调 generation、snapshot key、SHA-256 和 payload 契约后才服务；失败时 MUST 依次使用最后验证 Cache API 副本和迁移期 legacy KV 整套快照。

#### Scenario: manifest 指向截断 snapshot
- **WHEN** R2 snapshot JSON 无法解析或 hash 不匹配
- **THEN** Read Worker 不服务损坏数据并使用最后验证副本或 legacy 整套 fallback

#### Scenario: manifest generation 回退
- **WHEN** R2 manifest generation 低于最后验证 generation
- **THEN** Read Worker 拒绝回退 manifest 并继续服务最后验证版本

### Requirement: 公开请求不得依赖 VPS 或 PostgreSQL
正常和降级的公开读取 MUST 只使用 Cloudflare 内部 R2、Cache API 与迁移期 KV，不得访问 VPS 或 `DATABASE_URL`。

#### Scenario: VPS 离线
- **WHEN** VPS 和托管 PostgreSQL 均不可达但已有有效 R2 snapshot
- **THEN** 公开页面和 API 继续返回该 snapshot
```

## openspec/changes/migrate-data-plane-to-vps/specs/r2-snapshot-publication/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/r2-snapshot-publication/spec.md
- Lines: 1-22
- SHA256: a4717d5ceacb8e6ef9de2154c805cd536ac7c845162cfe5717a75a41b7713bda

```md
## ADDED Requirements

### Requirement: 公开 snapshot 必须规范化且不可变
系统 MUST 对不含运行时噪声的规范 JSON 计算 SHA-256，并使用 `snapshots/v1/<generation>-<sha256>.json` 保存不可变对象。

#### Scenario: 相同业务内容再次同步
- **WHEN** 新规范 payload hash 等于当前已发布 hash
- **THEN** 系统不增加 generation、不写 snapshot 且不更新 manifest

### Requirement: manifest 必须最后原子切换
系统 MUST 先上传 snapshot、回读并校验 hash，再覆盖 `public/manifest.json`；manifest MUST 包含 schema_version、generation、snapshot_key、content_sha256、published_at、source_observed_at、item_count 和 git_sha。

#### Scenario: snapshot 回读校验失败
- **WHEN** 上传对象缺失、截断或 hash 不匹配
- **THEN** 当前 manifest 保持不变且本次 publication 可安全重放

### Requirement: generation 必须单调递增
系统 MUST 在 PostgreSQL 中串行分配 generation，并拒绝较旧 run 覆盖较新 manifest。

#### Scenario: 较旧任务晚完成
- **WHEN** generation 9 在 generation 10 已发布后尝试切换 manifest
- **THEN** generation 9 被标记 obsolete 且 manifest 继续指向 generation 10
```

## openspec/changes/migrate-data-plane-to-vps/specs/sync-consistency/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/sync-consistency/spec.md
- Lines: 1-41
- SHA256: bd544e4abcbe9ec4f2733921c7a222bd68d9890b3befbdd6b2eecc97bba80437

```md
## MODIFIED Requirements

### Requirement: Primary 同步必须依赖主账户成功
primary 模式 MUST 在主账户完整拉取成功后才提交 PostgreSQL 权威事务和公开 snapshot；主账户失败时不得覆盖既有数据。

#### Scenario: 主账户失败而其他账户成功
- **WHEN** primary 模式主账户失败且至少一个其他账户成功
- **THEN** 本轮失败并保留原 PostgreSQL 状态和 R2 manifest

### Requirement: 同步快照必须完整提交
收藏与 calendar MUST 在同一 PostgreSQL事务中提交，并作为一个规范 snapshot 发布；事务、生成、上传、回读或 manifest 阶段失败不得向读取端暴露部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但 calendar 获取失败
- **THEN** 系统保留上一次权威状态和公开 snapshot 并记录失败

#### Scenario: 发布中途失败
- **WHEN** PostgreSQL 已提交但 R2 manifest 切换失败
- **THEN** 读取端继续使用上一次 manifest，pending publication 可幂等重放

#### Scenario: manifest 不完整
- **WHEN** manifest 缺少 required 字段、key 非法或 snapshot digest 不匹配
- **THEN** 读取端拒绝本次版本并使用最后验证副本或整套 legacy fallback

#### Scenario: 尚无 R2 manifest
- **WHEN** 系统处于迁移期且 `public/manifest.json` 不存在
- **THEN** 读取端只允许整套 legacy snapshot 兼容读取

### Requirement: 同步执行不得重叠
系统 MUST 使用宿主机锁和 PostgreSQL advisory lock 防止定时与手动任务同时刷新 token、提交权威状态或切换正式 manifest；shadow run 不得产生正式 publication。

#### Scenario: 已有同步正在执行
- **WHEN** 第二个任务在活动 run 持锁时到达
- **THEN** 第二个任务 skipped 且不调用 bgm.tv 或写正式状态

### Requirement: 用户凭证不得进入异步或持久化业务载荷
用户 token MUST 仅存在于当前受保护请求或同步进程内存，不得写入 PostgreSQL run/business rows、R2、backup manifest、飞书、日志或容器 image。

#### Scenario: 同步结束
- **WHEN** 周期同步、compare 或 apply 完成
- **THEN** 数据库、R2、通知和日志均不包含源或目标 token
```

## openspec/changes/migrate-data-plane-to-vps/specs/sync-run-notifications/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/sync-run-notifications/spec.md
- Lines: 1-22
- SHA256: ee6095e962b2c01c74050f7ce41083d754e6502c58af4a3794dd06a54a7bc312

```md
## ADDED Requirements

### Requirement: 每次同步必须发送飞书终态通知
系统 MUST 对 success、no_change、partial、failed 和 skipped 运行发送飞书 Webhook，内容包含 run ID、generation/hash、数据时间、变化计数、阶段耗时、backup/publication 结果和 git SHA。

#### Scenario: 数据没有变化
- **WHEN** 同步完成且规范内容 hash 未变化
- **THEN** 飞书收到 no_change 通知且 generation 不变

### Requirement: 通知不得影响业务结果
Webhook 失败 MUST 持久化为 notification_failed，但不得回滚 PostgreSQL、snapshot、manifest 或 backup。

#### Scenario: 飞书返回服务错误
- **WHEN** publication 与 backup 成功但 Webhook 重试耗尽
- **THEN** run 保留业务成功结果并记录通知失败供下一轮摘要

### Requirement: 通知和日志必须脱敏
通知、run 错误和日志 MUST 不包含 access token、refresh token、DATABASE_URL、Webhook URL/secret、R2 credential 或未经清理的上游响应体。

#### Scenario: 上游认证失败
- **WHEN** bgm.tv 返回包含请求上下文的认证错误
- **THEN** 飞书和持久化记录只包含稳定错误分类与脱敏摘要
```

## openspec/changes/migrate-data-plane-to-vps/specs/vps-container-delivery/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/vps-container-delivery/spec.md
- Lines: 1-29
- SHA256: 83b4433048f54a4663d36d7096f110a0594efd2a3e376560450eb48afb820ba8

```md
## ADDED Requirements

### Requirement: production image 必须最小且加固
production image MUST 使用官方最新 `node:alpine` multi-stage build，只包含 Node runtime、production dependencies、应用产物、CA certificates、最小 PostgreSQL client 和运行库，并以非 root、只读 root filesystem、无公网端口和最小 capabilities 运行。

#### Scenario: 扫描 production image
- **WHEN** CI 检查已构建的 production target
- **THEN** image 不包含源码、dev dependencies、编译器、git、curl、Python、编辑器、jq 或 DNS 调试包

### Requirement: debug 工具必须隔离到手动 target
debug target MUST 从 production 扩展并只添加经 Alpine 包索引验证的 HTTPS、DNS、TCP、进程、网络和 JSON 排障工具；production Compose MUST NOT 引用 debug image。

#### Scenario: 手动构建 debug image
- **WHEN** 操作者触发 debug workflow
- **THEN** GHCR 发布 `<git-sha>-debug` 且 production SHA image 内容不变化

### Requirement: GHCR 交付必须可追溯
CI MUST 记录实际 Node、Alpine、pnpm、base digest 和 git SHA，并发布不可覆盖的完整 git-SHA production tag；VPS Compose MUST 使用该 SHA 而不是浮动标签。

#### Scenario: 上游 node:alpine 更新
- **WHEN** 相同源代码在新的 base digest 上需要重建
- **THEN** 变更通过新的 reviewed commit 产生新 SHA image，旧 SHA image 不被覆盖

### Requirement: VPS 发布必须人工批准
第一版 MUST 由运维手工更新 Compose SHA、拉取 image、运行 shadow sync 和确认切流；GitHub Actions 不得持有 VPS SSH 部署权限。

#### Scenario: GHCR production build 完成
- **WHEN** 新 SHA image 已推送
- **THEN** VPS 在人工操作前继续运行原 SHA image
```

## openspec/changes/migrate-data-plane-to-vps/specs/vps-data-sync-runtime/spec.md

- Source: openspec/changes/migrate-data-plane-to-vps/specs/vps-data-sync-runtime/spec.md
- Lines: 1-40
- SHA256: 7e7a1e7ae0826a2f43e9c8851c20645bdd85ddab8a9371bdaaf46caddd0b8540

```md
## ADDED Requirements

### Requirement: VPS 同步必须作为一次性任务运行
系统 MUST 允许宿主机定时器通过 Docker Compose 启动一次同步任务，并以进程退出码表达成功、部分成功或失败，且不得暴露公网监听端口。

#### Scenario: 宿主机触发每日同步
- **WHEN** cron 执行一次 Compose sync service
- **THEN** 容器完成单轮同步后退出且不会保留常驻 HTTP 服务

### Requirement: 同步必须使用双层互斥
宿主机任务 MUST 使用进程锁，运行时 MUST 使用 PostgreSQL advisory lock；未获得任一锁的任务不得抓取或发布数据。

#### Scenario: 手动任务与定时任务重叠
- **WHEN** 第二个任务在首个任务持有数据库锁时启动
- **THEN** 第二个任务记录 skipped 结果并且不调用 bgm.tv 或 R2 写接口

### Requirement: 完整输入失败不得发布
系统 MUST 完整获取所有配置账户的收藏和 calendar 后才提交权威状态；认证、分页、校验或最终重试失败 MUST 保留上一版公开 manifest。

#### Scenario: 收藏分页中途失败
- **WHEN** 已读取部分页面后上游重试耗尽
- **THEN** 本轮记录失败且不确认删除、不提交公开 snapshot

### Requirement: 同步运行必须持久化终态
每轮任务 MUST 持久化 run ID、阶段、开始/结束时间、计数、耗时、git SHA 和脱敏错误，并区分 success、no_change、partial、failed 与 skipped。

#### Scenario: 备份失败但发布成功
- **WHEN** snapshot 已发布而数据库备份上传失败
- **THEN** run 终态为 partial 且保留发布与备份各自结果

### Requirement: 媒体部分失败不得阻塞主数据发布
系统 MUST 在 collection 与 calendar 完整提交后独立处理媒体刷新；单个 detail、metadata 或 image 失败时 MUST 使用 PostgreSQL 中最后成功媒体状态构建 snapshot、将 run 标记 partial 并安排后续重试。

#### Scenario: 单张图片刷新失败
- **WHEN** collection 与 calendar 成功且一个 subject 图片下载或 R2 写入最终失败
- **THEN** 系统使用该 subject 最后成功图片引用发布主 snapshot，run 为 partial，且失败图片进入有界重试状态

#### Scenario: 新 subject 尚无成功图片
- **WHEN** 新 subject 的图片刷新失败且数据库中没有 last-known-good 图片
- **THEN** snapshot 使用明确的非 cached 图片状态，不得伪造 R2 引用或阻塞其余主数据发布
```

