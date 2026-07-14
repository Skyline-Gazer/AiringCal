# Comet Design Handoff

- Change: stabilize-sync-consistency
- Phase: design
- Mode: compact
- Context hash: e5295d7dde79c014e6d8cb874f9c127d88cf218ef1f78299dbfe7279544beeb0

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/stabilize-sync-consistency/proposal.md

- Source: openspec/changes/stabilize-sync-consistency/proposal.md
- Lines: 1-25
- SHA256: 1e5b907c9670e034cd8e34dacaecd6b7bb3b7526ee951af642548e87580af4bb

```md
## Why

同步链路目前允许主账户失败后以空集合覆盖有效数据，token 刷新也可能被并发执行；同时“完整同步”的名称与实际复制语义不一致。这些问题会造成数据丢失、授权失效或用户误解破坏性操作。

## What Changes

- primary 模式只有在主账户成功拉取时才允许生成并写入新快照。
- 同步结果采用完整快照提交规则，失败不得留下收藏与日历半更新状态。
- 防止 Cron 与手动同步重叠执行同一刷新和同步流程。
- 明确管理端同步的语义、方向、输入校验、失败报告和幂等边界。
- 对 token 状态探测中的网络错误与真实无效 token 进行区分，避免误触发刷新。

## Capabilities

### New Capabilities

- `sync-consistency`: 定时同步、primary 模式、token 生命周期和管理端写回的安全一致性要求。

### Modified Capabilities

无。

## Impact

影响 `cron.ts`、bgm.tv 客户端、KV 状态布局、手动同步端点、管理页提示及同步测试。若采用新的同步锁或快照元数据，部署配置会随之更新。
```

## openspec/changes/stabilize-sync-consistency/design.md

- Source: openspec/changes/stabilize-sync-consistency/design.md
- Lines: 1-37
- SHA256: d16de968843a153910dd8c556d6768d3eff09d2f4fbdb9a2f1191ae6e79ae902

```md
## Context

当前同步先把失败账户映射为空数组，再在 primary 模式选取主账户结果；收藏和日历分别写入 KV。Cron 与 HTTP 手动触发可并发执行，token 刷新也没有互斥边界。

## Goals / Non-Goals

**Goals:**

- 任何失败都不得把有效主账户数据覆盖为空。
- 一次同步只发布完整结果，并避免重叠执行。
- 将管理端“完整同步”改为准确的复制语义。

**Non-Goals:**

- 不做双向冲突解决。
- 不自动删除目标账户独有条目。

## Decisions

- primary 模式单独检查对应 `PromiseSettledResult`，失败即终止。
- 将收藏、日历和元数据写为单个版本化快照 key，公开 API 先读取当前快照；避免跨 key 半更新。
- 同步互斥优先采用最小可行的单执行协调机制；若 Workers KV 无法提供所需原子性，则使用一个小型 Durable Object，而不是伪造 KV 锁。
- `tokenStatus` 返回明确状态：有效、无效、探测失败；只有前两者中的刷新条件可消费 refresh token。
- 管理端动作命名为“复制全部条目”与“复制选中条目”，服务端做严格请求校验。

## Risks / Trade-offs

- [引入 Durable Object 增加配置] → 仅在无法用现有平台保证互斥时使用，保持单对象单职责。
- [快照 key 迁移导致首次读取差异] → 读取端提供旧 key 的短期兼容回退，首次成功同步后切换。

## Migration Plan

先部署兼容读取，再执行一次同步生成新快照，确认健康状态后移除旧写入。回滚时旧 key 保持可读。

## Open Questions

深度设计阶段根据 Cloudflare 当前能力确认互斥实现及旧 key 兼容周期。
```

## openspec/changes/stabilize-sync-consistency/tasks.md

- Source: openspec/changes/stabilize-sync-consistency/tasks.md
- Lines: 1-17
- SHA256: 860a295147ca9720506a3f315264661464207f814eddbf9ae9154f084a55df5f

```md
## 1. 失败保护

- [ ] 1.1 添加 primary 主账户失败保护和回归测试
- [ ] 1.2 区分 token 无效、临近过期和探测故障
- [ ] 1.3 为同步请求添加严格输入验证

## 2. 一致性与并发

- [ ] 2.1 实现完整同步快照的生成、发布和兼容读取
- [ ] 2.2 实现 Cron 与手动同步的单执行协调
- [ ] 2.3 保证失败路径只记录错误而不替换当前快照

## 3. 管理端语义

- [ ] 3.1 将 full/partial 界面文案改为全部复制/选择复制
- [ ] 3.2 验证目标账户独有条目不会被误删
- [ ] 3.3 更新同步状态和错误报告
```

## openspec/changes/stabilize-sync-consistency/specs/sync-consistency/spec.md

- Source: openspec/changes/stabilize-sync-consistency/specs/sync-consistency/spec.md
- Lines: 1-43
- SHA256: 98256a01af31417714453403e6ef47bcd39dc4ca4c4d3a9460dd207a3ce82f81

```md
## ADDED Requirements

### Requirement: Primary 同步必须依赖主账户成功
primary 模式 MUST 在主账户拉取成功后才生成新快照，主账户失败时不得覆盖已有收藏。

#### Scenario: 主账户失败而其他账户成功
- **WHEN** primary 模式的主账户拉取失败且至少一个其他账户成功
- **THEN** 本次同步失败并保留原有收藏和日历快照

### Requirement: 同步快照必须完整提交
收藏与日历 MUST 作为同一次同步结果提交；生成阶段失败时不得留下部分新数据。

#### Scenario: 日历获取失败
- **WHEN** 收藏已拉取但日历获取失败
- **THEN** 系统保留上一次完整快照并记录失败状态

### Requirement: 同步执行不得重叠
系统 MUST 防止 Cron 与手动触发的同步流程同时刷新同一 token 或写入同一快照。

#### Scenario: 已有同步正在执行
- **WHEN** 第二个同步请求在锁有效期内到达
- **THEN** 系统拒绝或跳过第二次执行且不刷新 token

### Requirement: Token 探测必须区分失效与网络故障
系统 MUST 仅在确认 token 无效或临近到期时刷新；网络或上游临时故障不得被当作 token 无效。

#### Scenario: token_status 网络超时
- **WHEN** token 状态探测因网络问题失败
- **THEN** 同步报告可重试错误且不消费 refresh token

### Requirement: 管理同步语义必须明确
管理端 MUST 将当前行为定义为“将源账户条目复制或更新到目标账户”，不得声称目标账户会被完整镜像。

#### Scenario: 目标账户存在源账户没有的条目
- **WHEN** 用户执行完整复制
- **THEN** 目标账户独有条目保持不变且界面明确提示该行为

### Requirement: 同步输入必须验证
系统 MUST 验证模式、方向、用户名、token 和条目 ID；无效输入不得触发 bgm.tv 写操作。

#### Scenario: 模式无效
- **WHEN** 请求提供非 full 或 partial 的模式
- **THEN** 系统返回 400 且不调用 bgm.tv
```

