# Comet Design Handoff

- Change: stop-kv-write-amplification
- Phase: design
- Mode: compact
- Context hash: f6a19bd3d884b67e5132085814bde03c7871a7e87646f0711e5efcc4b5688b3e

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/stop-kv-write-amplification/proposal.md

- Source: openspec/changes/stop-kv-write-amplification/proposal.md
- Lines: 1-27
- SHA256: 26378d445cbe871727e25fae1834cd6218c44d631278c666b83096ad752e2e3a

```md
## Why

生产 KV 每四小时出现一次与 Cron 完全一致的读写尖峰，月内写入已远超 Workers KV Free Plan 的每日额度。根因是每轮同步无条件为全部收藏与 calendar subject 创建媒体任务，并重复覆盖未变化的 refresh、metadata 与 image 状态；必须先独立止血，避免后续架构迁移期间继续耗尽配额。

## What Changes

- 将业务 Cron 从每四小时一次改为每天 04:00（Asia/Shanghai）一次。
- 恢复 subject detail/media 的 6 至 8 天确定性到期判断，未到期且缓存完整的 subject 不进入 Media Queue。
- 对 refresh、metadata 与 image 状态实施相同内容零写入，禁止仅因新 Workflow instance 而覆盖缓存。
- 引入每日媒体任务 QoS：新增或发生变化的条目优先，其次为 hot 到期条目、cold 七日轮转条目与失败重试；soft limit 50、hard limit 100。
- 补充 KV 写放大回归测试、运行指标和止血运维文档。

## Capabilities

### New Capabilities

- `sync-write-budget`: 定义每日同步与媒体刷新在 Free Plan 下的写入预算、任务优先级和预算耗尽行为。

### Modified Capabilities

- `durable-sync-workflow`: 将 schedule 改为日频，并要求未变化输入不产生逐 subject 副作用。
- `cache-refresh-lifecycle`: 恢复 6 至 8 天到期筛选、相同内容零写入和有界媒体调度。
- `project-quality-gates`: 增加无变化大批量同步不得产生逐 subject KV 写入的自动检查，并同步 Cron 文档约束。

## Impact

影响 sync-worker Workflow 与 Cron 配置、media-worker 的刷新判定、共享 storage/domain helper、相关测试和 README。公开 HTTP API 与现有 KV key 读取契约保持兼容；本 change 不引入 D1、不切换 R2 快照读取，也不清理旧 KV 数据。
```

## openspec/changes/stop-kv-write-amplification/design.md

- Source: openspec/changes/stop-kv-write-amplification/design.md
- Lines: 1-39
- SHA256: ab96daba2282f00d54855c47ce0db2a3d70b75c5e00bb06df48fc866deaa16c3

```md
## Context

生产健康数据每轮包含约 659 个 refresh job，Cron 每四小时运行一次。Workflow 当前为所有 subject 生成全组件 V3 job；consumer 即使 detail 与图片均可复用，也会重写 running/final refresh、metadata 与 image status。Free Plan KV 每日写额度因此在单轮内耗尽。

## Goals / Non-Goals

**Goals:**

- 在不改变公开 API 和存储权威关系的前提下立即停止写放大。
- 日级同步、6 至 8 天媒体刷新与每日最多 100 个媒体任务。
- 未变化 subject 不产生逐 subject KV 副作用。

**Non-Goals:**

- 不引入 D1 或新的 R2 数据桶。
- 不切换公开 snapshot 格式和读取路径。
- 不清理已有 KV key。

## Decisions

1. Cron 固定为每天 04:00 Asia/Shanghai。相较继续四小时调度后在 consumer 限流，源头降频可同时减少 Workflow staging 与运行状态写入。
2. 刷新规划在 enqueue 前读取 detail/meta/image/refresh 状态，使用现有 `nextSubjectRefreshAt` 判定到期，并仅为缺失或到期组件构造 job。相较把所有任务交给 consumer 丢弃，这避免 Queue 与 Durable Object 开销。
3. job 去重仍覆盖 Workflow step 重放；跨日是否刷新由缓存到期而不是 instance-specific job ID 决定。
4. 任务按 changed/new、hot due、cold shard、retry 排序，先截断至 soft limit 50；只有 changed/new 超过 soft limit 时可增长到 hard limit 100。
5. consumer 写入前比较规范化值；时间戳仅在真实状态转换或内容变化时更新，图片完全复用时不重写 image status。

## Risks / Trade-offs

- [读取旧状态会增加 KV reads] → 659 个 subject 的有界读取远低于每日读额度，并通过 chunk 限制单 step 操作数。
- [每日同步降低即时性] → 用户已确认日级新鲜度；手动 Workflow 仍可用于诊断，但服从同一媒体预算。
- [预算截断造成积压] → 使用确定性排序与 cold shard，次日重新规划，不持久化大队列。

## Migration Plan

先部署代码与测试，再更新 Cron；若生产异常，回退到上一 SHA，但不得恢复无条件全量媒体 job。部署后用 24 小时 KV 指标确认写入低于 100，并核对一次 scheduled Workflow 成功。

## Open Questions

无。
```

## openspec/changes/stop-kv-write-amplification/tasks.md

- Source: openspec/changes/stop-kv-write-amplification/tasks.md
- Lines: 1-21
- SHA256: 74c3d4a39e2a354946c3401663145fa3ad70753df2b71c7a5c137631567319ff

```md
## 1. Regression Baseline

- [ ] 1.1 Add write-observing KV and Queue test doubles that count subject refresh, metadata, image status and Workflow writes
- [ ] 1.2 Add a failing 659-subject unchanged-cache regression proving the current workflow produces forbidden media jobs and writes

## 2. Bounded Refresh Planning

- [ ] 2.1 Restore component-level 6-to-8-day due selection before enqueue and preserve Workflow replay idempotency
- [ ] 2.2 Implement priority ordering, daily soft limit 50, hard limit 100 and deterministic cold seven-day shard selection
- [ ] 2.3 Make media consumer skip unchanged metadata, image status and refresh terminal writes while preserving errors and tombstones

## 3. Daily Scheduling and Observability

- [ ] 3.1 Verify Wrangler Cron configuration syntax and change the production trigger to daily 04:00 Asia/Shanghai
- [ ] 3.2 Add run counters for candidates, selected, deferred and avoided writes without adding per-subject KV state
- [ ] 3.3 Update README, architecture and deployment assertions for daily sync, QoS and zero-write semantics

## 4. Verification and Release

- [ ] 4.1 Run focused sync/media/storage tests, full typecheck/test/build and Wrangler dry-runs
- [ ] 4.2 Commit and push each accepted task atomically, deploy the converged SHA, and record a 24-hour production KV-write acceptance check
```

## openspec/changes/stop-kv-write-amplification/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/stop-kv-write-amplification/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-21
- SHA256: 979080c3f153169528e7d512cfcb2915bf83a031d576dac610cd4e6d50996c01

```md
## MODIFIED Requirements

### Requirement: subject 刷新时间必须分散
系统 MUST 根据 subject ID 将常规刷新时间确定性分散在 6 至 8 天，并且只有到达该时间、缓存缺失或源内容发生变化时才规划对应组件刷新。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个不同 subject 在同一时刻完成刷新
- **THEN** 其下一次刷新时间按 subject ID 分散而不是落在同一时刻

#### Scenario: subject 尚未到期
- **WHEN** detail、metadata 与两种图片均完整且确定性刷新时间仍在未来
- **THEN** 系统不创建该 subject 的媒体任务

## ADDED Requirements

### Requirement: 相同媒体状态不得重复写入
Media consumer MUST 在写 refresh、metadata 或 image status 前比较规范内容；缓存复用且状态未变化时不得执行对应 KV PUT。

#### Scenario: 两种图片均可复用
- **WHEN** job 的源 URL 与已缓存 source URL 相同且 detail 未到期
- **THEN** consumer 不下载图片且不重写 image status 或 metadata
```

## openspec/changes/stop-kv-write-amplification/specs/durable-sync-workflow/spec.md

- Source: openspec/changes/stop-kv-write-amplification/specs/durable-sync-workflow/spec.md
- Lines: 1-15
- SHA256: 4c77b441548b25fa5f29ed517f5e00454b636974b41195e3c3e2f6de3847365f

```md
## ADDED Requirements

### Requirement: 定时同步必须按日运行
系统 MUST 使用 Worker Cron 在每天 04:00 Asia/Shanghai 创建一个 live Workflow instance，且不得保留每四小时业务同步 schedule。

#### Scenario: 一个完整自然日
- **WHEN** 生产 Cron 正常启用且没有手动触发
- **THEN** 系统只创建一个 scheduled live Workflow instance

### Requirement: 未变化同步不得产生逐 subject 副作用
Workflow MUST 在 enqueue 前筛除未到期且缓存完整的 subject，不得仅因 instance ID 变化而投递全组件媒体任务。

#### Scenario: 659 个 subject 均未变化且未到期
- **WHEN** 每日 Workflow 完成 collections 与 calendar 抓取
- **THEN** Media Queue 收到零个任务且没有逐 subject KV 写入
```

## openspec/changes/stop-kv-write-amplification/specs/project-quality-gates/spec.md

- Source: openspec/changes/stop-kv-write-amplification/specs/project-quality-gates/spec.md
- Lines: 1-17
- SHA256: 6e8e9e3e042aec9eadf58df60acbc0d8ec8227e5fcdb2662d2a392dd23b126d9

```md
## MODIFIED Requirements

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、每日同步行为、Workflow 运维命令及部署流程一致，且不得声明 Free Plan 未启用的原生 Workflow schedule、已删除的 trigger queue 或每四小时业务同步。

#### Scenario: Free Plan 每日定时触发已激活
- **WHEN** 生产止血变更部署完成
- **THEN** 文档明确日频 Worker Cron 只创建 live Workflow instance，并记录媒体预算与未变化零写入语义

## ADDED Requirements

### Requirement: 写放大必须有自动回归门禁
质量门禁 MUST 验证大批量未变化 subject 不产生逐 subject KV 写入或媒体投递。

#### Scenario: 659 个稳定 subject 回归样例
- **WHEN** 测试运行一次完整每日 Workflow 且所有缓存未到期
- **THEN** 测试观测到零个 Media Queue message 与零个 subject refresh/meta/image PUT
```

## openspec/changes/stop-kv-write-amplification/specs/sync-write-budget/spec.md

- Source: openspec/changes/stop-kv-write-amplification/specs/sync-write-budget/spec.md
- Lines: 1-30
- SHA256: 55e0b36b11a005a17d40c8f1e830eebdca44b62f35be0b26d7adaab2d6d73de2

```md
## ADDED Requirements

### Requirement: 媒体调度必须受每日预算约束
系统 MUST 在任务进入 Media Queue 前应用每日 soft limit 50 与 hard limit 100，并按新增或变化、hot 到期、cold 轮转、失败重试的顺序选择任务。

#### Scenario: 候选任务超过 soft limit
- **WHEN** 当日存在 80 个普通到期候选且没有更高优先级任务
- **THEN** 系统最多投递 50 个任务并将其余候选留待下一日重新规划

#### Scenario: 新增任务超过 soft limit
- **WHEN** 当日有 60 个新增 subject 需要必要媒体补全
- **THEN** 系统可以超过 soft limit 但不得超过 hard limit 100

### Requirement: 媒体预算耗尽不得阻塞收藏发布
系统 MUST 独立完成收藏与 calendar snapshot 发布，媒体候选被截断时不得使 Workflow 失败。

#### Scenario: 当日媒体 hard limit 已用尽
- **WHEN** Workflow 完成收藏抓取且没有剩余媒体预算
- **THEN** 系统发布收藏 snapshot、记录零投递并正常完成

### Requirement: 所有 live 运行必须共享每日媒体预算
系统 MUST 以 UTC 日期作为预算周期，使 scheduled live 与 manual live Workflow 共享同一 soft limit 与 hard limit；系统不得提供绕过 hard limit 的强制投递参数。Shadow Workflow MUST 不投递媒体任务。

#### Scenario: 手动运行发生在定时运行之后
- **WHEN** scheduled live 已用尽当日 hard limit，随后触发 manual live
- **THEN** manual live 投递零个媒体任务、仍发布收藏 snapshot 并正常完成

#### Scenario: 运行 shadow Workflow
- **WHEN** 任意 UTC 日期触发 shadow Workflow
- **THEN** Workflow 不预留媒体预算且不向 Media Queue 投递任务
```

