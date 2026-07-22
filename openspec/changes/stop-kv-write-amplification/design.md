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
6. Queue 与 Durable Object 之间不存在分布式事务，且 producer reject 不能证明零副作用。为严格保护 Free Plan hard limit，系统采用 fail-closed：稳定 reservation 在 coordinator 实际 UTC 日内先占用逻辑预算、最多发起一次 Queue send；任何歧义结果保留预算且不重发，但不得阻塞 snapshot 发布。确定性 job ID 与 per-subject coordinator 负责 at-least-once delivery 的业务去重。

## Risks / Trade-offs

- [读取旧状态会增加 KV reads] → 659 个 subject 的有界读取远低于每日读额度，并通过 chunk 限制单 step 操作数。
- [每日同步降低即时性] → 用户已确认日级新鲜度；手动 Workflow 仍可用于诊断，但服从同一媒体预算。
- [预算截断造成积压] → 使用确定性排序与 cold shard，次日重新规划，不持久化大队列。
- [Queue 结果不确定时可能少投递] → 保留当日预算且不重发，次日从权威缓存状态重新规划；优先保证 hard ceiling 与零重复 KV 副作用。

## Migration Plan

先部署代码与测试，再更新 Cron；若生产异常，回退到上一 SHA，但不得恢复无条件全量媒体 job。部署后用 24 小时 KV 指标确认写入低于 100，并核对一次 scheduled Workflow 成功。

## Open Questions

无。
