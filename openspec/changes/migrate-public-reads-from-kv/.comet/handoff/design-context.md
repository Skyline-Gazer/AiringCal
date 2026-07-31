# Comet Design Handoff

- Change: migrate-public-reads-from-kv
- Phase: design
- Mode: compact
- Context hash: 0fd2dd5a85f7568ad6a4cf64b42b355cd0cac532edda8b210f200d17b8e6f41d

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/migrate-public-reads-from-kv/proposal.md

- Source: openspec/changes/migrate-public-reads-from-kv/proposal.md
- Lines: 1-30
- SHA256: b7748212d310c74065f5eafd3b9931edc01566a938b796c208b1bcb783deb4b7

```md
## Why

D1/R2 核心落地后，公开读取仍依赖旧 KV snapshot 与逐 subject 状态，无法真正把 KV 降为发布指针。需要一个独立、可观测、可回滚的迁移阶段，把 legacy media metadata 导入 D1，验证 R2 shadow snapshot 与当前 API 等价，再安全切换 Read Worker 并渐进清理旧 key。

## What Changes

- 创建可恢复的 legacy KV metadata 迁移流程，每批最多处理 50 个 subject，并在 D1 保存游标与计数。
- 保持图片二进制 R2 key 不变，只迁移 detail/meta/image/refresh 元数据；重复运行不得覆盖更新的 D1 状态。
- 在旧 KV 继续服务期间生成并比较 R2 shadow snapshot，核对五类收藏、subject IDs、calendar、分页、图片和 NSFW 投影。
- 连续 7 次每日 shadow 一致且 KV 预算达标后，通过 `public:current` 切换 Read Worker 到 R2 `PublicSnapshotV1`。
- Read Worker 验证 pointer、schema、generation 与 hash；失败时使用最后已验证缓存，再回退旧 KV manifest。
- `/api/health` 从 D1 暴露 generation、预算与迁移摘要，同时保持现有字段兼容。
- 切换稳定 14 天后每天删除最多 50 至 100 个旧逐 subject KV key，并保留可回滚 R2 generation。

## Capabilities

### New Capabilities

- `legacy-state-migration`: 定义 resumable legacy KV metadata 导入、shadow 等价验证、切换门禁和渐进清理。

### Modified Capabilities

- `public-read-contracts`: 公开 API 改从已验证 R2 snapshot 读取并保持既有 JSON、分页和错误契约，异常时执行有界 fallback。
- `durable-sync-workflow`: 暴露迁移与 shadow 验证状态，并在切换后仅维护新发布链路。
- `cache-refresh-lifecycle`: 移除逐 subject KV 作为权威状态，保留兼容期只读 fallback 后渐进清理。
- `project-quality-gates`: 增加 7 次 shadow 一致门禁、回滚、迁移幂等和生产 KV 配额验收。

## Impact

影响 read-worker、sync migration Workflow、D1/R2/KV adapters、健康与缓存端点、迁移脚本、回滚 runbook 和测试。所有公开 URL 与响应 shape 保持兼容；本 change 不重新下载或复制现有图片，也不引入小时级同步或同日二次发布。
```

## openspec/changes/migrate-public-reads-from-kv/design.md

- Source: openspec/changes/migrate-public-reads-from-kv/design.md
- Lines: 1-41
- SHA256: 2acae7bd344cfead5c60f3539b7af0c3c57bd9ce15483322444e92fb8da0380c

```md
## Context

D1/R2 核心完成后，旧 KV snapshot 仍服务公开 API，legacy detail/meta/image 状态也尚未迁移。直接切换会有投影缺失与回滚风险，因此需要可恢复导入、连续 shadow 等价验证和延迟清理。

## Goals / Non-Goals

**Goals:**

- 幂等、分批导入当前 subject 的 legacy metadata，复用现有图片对象。
- 连续 7 次日同步验证 R2 snapshot 与旧公开结果等价。
- 安全切换 Read Worker，并保留缓存和旧 KV 双层 fallback。
- 稳定 14 天后以每日小批次清理 legacy key。

**Non-Goals:**

- 不重新抓取全部图片，不复制 R2 图片。
- 不改变公开 HTTP URL、分页参数或响应 shape。
- 不在迁移期间双写 legacy 逐 subject KV。

## Decisions

1. 迁移对象来自当前 D1 收藏 subject 集合，每批最多 50；游标、成功/跳过/失败计数保存在 `app_state`，D1 已有更新状态时跳过 legacy 值。
2. shadow 比较规范化公开结果而非原始存储 JSON，覆盖五类 subject ID/字段、calendar、summary、图片与 NSFW，并记录连续成功次数。
3. 只有连续 7 次成功且每日 KV 写入达标才允许写 `public:current`。失败重置连续计数，但不删除已生成 R2 对象。
4. Read Worker 验证 pointer、schema、generation 和 hash；失败时先使用 Cache API 中最后验证版本，再回退旧 KV manifest。
5. 切换后 14 天内旧 KV 只读；清理每天最多 100 key，保留至少一个可回滚 generation。

## Risks / Trade-offs

- [legacy 状态不完整] → 缺失项记录为待正常媒体轮转补全，不阻塞其余迁移。
- [shadow 差异被排序噪声触发] → 比较前按稳定 key 排序并剔除运行时间字段。
- [R2 暂时不可用] → 最后验证缓存与旧 KV fallback 保证服务连续性。
- [清理后回滚能力下降] → 14 天观察期结束后才清理，且回滚依赖 R2 generation 而非已删 legacy metadata。

## Migration Plan

部署兼容读取与 migration runner，完成 metadata 导入；运行至少 7 次 shadow；满足门禁后切 pointer；观察 14 天再启用限速清理。任一阶段可关闭新读取并回到旧 KV，不回滚 D1 数据。

## Open Questions

无。
```

## openspec/changes/migrate-public-reads-from-kv/tasks.md

- Source: openspec/changes/migrate-public-reads-from-kv/tasks.md
- Lines: 1-29
- SHA256: 01fdb46d7b453fcf62f2c299e163aae8dada3b92e05f5cd06c73c9a0998a13a7

```md
## 1. Resumable Legacy Import

- [ ] 1.1 Implement a maximum-50-subject migration batch using the current D1 collection set and app_state cursor
- [ ] 1.2 Map legacy detail/meta/image/refresh records into D1 only when no newer row exists and reuse existing image R2 keys
- [ ] 1.3 Add interruption, replay, missing-key and stale-overwrite migration tests

## 2. Shadow Equivalence Gate

- [ ] 2.1 Build stable legacy-vs-R2 comparison for all collection fields, subject IDs, calendar, summary, images and NSFW
- [ ] 2.2 Persist shadow streak and sanitized diff summary, resetting streak on any business difference
- [ ] 2.3 Enforce seven consecutive daily matches and KV-budget acceptance before pointer cutover is permitted

## 3. Public Read Cutover

- [ ] 3.1 Add verified PublicSnapshotV1 R2 loading and Cache API storage while preserving existing API response shapes and pagination
- [ ] 3.2 Implement fallback order of last verified cache then legacy KV manifest for pointer/R2/schema/hash failures
- [ ] 3.3 Extend health with non-breaking generation, source, budget and migration summaries

## 4. Rollback and Cleanup

- [ ] 4.1 Add explicit cutover and rollback operations that never require reverting D1 rows
- [ ] 4.2 Implement a 14-day read-only observation gate and maximum-100-key daily legacy cleanup cursor
- [ ] 4.3 Preserve at least one verified R2 generation and document cleanup stop/recovery procedures

## 5. Verification and Production Acceptance

- [ ] 5.1 Run migration, shadow, fallback, API compatibility, full repository and Wrangler deployment gates
- [ ] 5.2 Observe seven production shadow runs, perform cutover, observe 14 days, then enable cleanup with KV writes below the accepted budget
- [ ] 5.3 Commit and push each accepted task atomically and synchronize all user-facing architecture/runbook documentation
```

## openspec/changes/migrate-public-reads-from-kv/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/migrate-public-reads-from-kv/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-15
- SHA256: 9cfeb627ca49cf0d451f07a2fb2b1e66b4a1a5918caa22f77562c61f4654d646

```md
## ADDED Requirements

### Requirement: legacy 媒体状态只能作为兼容输入
迁移期间系统 MUST 允许读取 legacy detail/meta/image 状态补充尚未导入的 subject，但新媒体结果只能写入 D1。

#### Scenario: D1 尚无 subject media
- **WHEN** shadow snapshot 构建遇到仅存在于 legacy KV 的已缓存图片引用
- **THEN** 系统可使用该引用生成候选并安排迁移，不覆盖或重写 legacy key

### Requirement: 迁移不得复制图片二进制
系统 MUST 复用 legacy metadata 中现有 `airing-cal-images` R2 key，不得因状态迁移重新下载或复制图片。

#### Scenario: legacy 图片对象有效
- **WHEN** metadata 指向现有 common 和 large R2 key
- **THEN** D1 导入保存相同引用且 R2 PUT 为零
```

## openspec/changes/migrate-public-reads-from-kv/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/migrate-public-reads-from-kv/specs/durable-sync-workflow/spec.md
- Lines: 1-15
- SHA256: 678a392ed2bfbf1206dea95ab54e0a1d84d3baa30f9edb2df31e17ec6b52a3ac

```md
## ADDED Requirements

### Requirement: Workflow 必须记录 shadow 等价结果
每日 Workflow MUST 在迁移期比较规范化 legacy 公开结果与候选 R2 snapshot，并原子更新连续成功计数和差异摘要。

#### Scenario: 两端仅发布时间不同
- **WHEN** legacy 与 R2 业务字段相同但生成时间不同
- **THEN** shadow 比较视为一致并增加 streak

### Requirement: 切换后 Workflow 不得恢复 legacy 写入
公开读取切换后 Workflow MUST 继续只维护 D1、R2 与 pointer，不得双写逐 subject legacy KV。

#### Scenario: 切换后媒体状态变化
- **WHEN** subject 图片或 NSFW 投影更新
- **THEN** 新状态写入 D1并由下一 snapshot 发布，不写 legacy image/meta key
```

## openspec/changes/migrate-public-reads-from-kv/specs/legacy-state-migration/spec.md

- Source: openspec/changes/migrate-public-reads-from-kv/specs/legacy-state-migration/spec.md
- Lines: 1-22
- SHA256: 089d17d9d9360e96a5cc2073f526d486ff95871b51b6aece1f48cca357ee06fa

```md
## ADDED Requirements

### Requirement: legacy metadata 迁移必须可恢复且幂等
系统 MUST 按当前收藏 subject 集合每批最多 50 个读取 legacy detail/meta/image/refresh KV，并在 D1 保存游标与计数；已有更新 D1 状态不得被覆盖。

#### Scenario: 迁移在第三批中断
- **WHEN** runner 在部分批次完成后重启
- **THEN** 系统从持久化游标继续且已导入 subject 不重复覆盖

### Requirement: shadow 一致必须连续七次
系统 MUST 对规范化旧公开结果与 R2 snapshot 执行逐字段比较，只有连续 7 次每日成功且 KV 预算达标才允许切换。

#### Scenario: 第六次出现 calendar 差异
- **WHEN** shadow 连续成功六次后发现 calendar 不一致
- **THEN** 连续成功计数重置且公开读取保持旧 KV

### Requirement: legacy 清理必须延迟且限速
切换成功后系统 MUST 保持 legacy KV 只读至少 14 天，之后每天最多删除 100 个旧逐 subject key。

#### Scenario: 切换后第十天
- **WHEN** 清理任务运行
- **THEN** 系统删除零个 legacy key
```

## openspec/changes/migrate-public-reads-from-kv/specs/project-quality-gates/spec.md

- Source: openspec/changes/migrate-public-reads-from-kv/specs/project-quality-gates/spec.md
- Lines: 1-15
- SHA256: c9dbfead2fd325e01cff97d3da1476e67f11ec1f3e9be90c843afdb12e6c34e0

```md
## ADDED Requirements

### Requirement: 公开读取切换必须有影子门禁
自动与生产验收 MUST 验证连续 7 次 shadow 一致、KV 预算达标、R2 pointer 校验与旧 KV fallback 后才允许切换。

#### Scenario: shadow streak 不足
- **WHEN** 只有 6 次连续一致结果
- **THEN** 切换操作被拒绝且公开读取仍使用旧 KV

### Requirement: 迁移和回滚必须可演练
质量门禁 MUST 覆盖批次中断续跑、重复导入、缺失 legacy key、pointer 回滚和限速清理。

#### Scenario: 新读取切换后回滚
- **WHEN** 运维恢复上一已验证 generation 或旧读取策略
- **THEN** API 继续满足既有契约且不需要回滚 D1 行
```

## openspec/changes/migrate-public-reads-from-kv/specs/public-read-contracts/spec.md

- Source: openspec/changes/migrate-public-reads-from-kv/specs/public-read-contracts/spec.md
- Lines: 1-22
- SHA256: 6d34258b6eb4bacdcdf3084d0038e2d8e30fd616372a7ef9682fd97598ff88a3

```md
## ADDED Requirements

### Requirement: 公开读取必须验证 R2 snapshot
Read Worker MUST 验证 `public:current`、支持的 schema version、generation 与 content hash 后才使用 R2 snapshot，并保持现有 API JSON 与分页契约。

#### Scenario: pointer 指向未知 schema
- **WHEN** `public:current` 的 schema version 不受支持
- **THEN** Read Worker 不使用该对象并执行兼容 fallback

### Requirement: 公开读取必须有两级 fallback
R2 snapshot 验证或读取失败时，Read Worker MUST 先使用 Cache API 中最后已验证版本；不存在时 MUST 回退旧 KV manifest。

#### Scenario: R2 暂时返回错误
- **WHEN** 当前 pointer 有效但 R2 GET 失败且缓存存在
- **THEN** API 返回最后已验证缓存版本且记录降级状态

### Requirement: health 必须暴露迁移与预算摘要
`/api/health` MUST 在不移除既有字段的前提下增加当前 generation、snapshot source、D1 budget 与 legacy migration 摘要。

#### Scenario: 系统仍处于 shadow 阶段
- **WHEN** 尚未满足七次一致门禁
- **THEN** health 返回旧读取 source、shadow streak 与迁移游标摘要
```

