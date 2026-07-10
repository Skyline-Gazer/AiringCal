# Brainstorm Summary

- Change: adopt-free-plan-sync-workflow
- Date: 2026-07-10

## 确认的技术方案

使用 Cloudflare Workflow 作为 Free Plan 下的耐久同步编排器，只负责收藏/calendar 获取、staging、shadow/live 快照发布、刷新计划和运行状态。subject detail、metadata、图片下载与 R2 继续由 Media Queue 处理。部署与业务同步彻底解耦，先上线无 schedule 的 shadow Workflow，生产验证后再用每 4 小时 schedule 替换旧 Cron。

## 关键取舍与风险

- Workflow step 以页码、收藏类型和 chunk index 确定命名，payload 存 KV，step 只返回摘要，以满足 10 ms CPU、50 subrequest 和 1 MiB 输出限制。
- KV 多 key 发布通过 staging 和最终提交点避免读取端看到半成品；获取或发布失败保留上一版正式 snapshot。
- Media Queue 至少一次投递通过 `job_id` 和 refresh 状态去重；降低并发会延长最终收敛时间，但不会阻塞 snapshot 发布。
- schedule 与旧 Cron 不同时启用；切换和清理 trigger queue 分成生产验证后的独立原子提交。

## 测试策略

按 TDD 实施：先覆盖收藏分页、Workflow step 确定性与重放、错误重试分类、shadow/live 隔离、Media Queue 去重与延迟重试、账号 apply 无重复拉取、cache pagination 和 CI 不等待业务同步，再实现对应行为。最终执行全量 typecheck、test、build check、diff check、本地 Workflow smoke 与生产 shadow/live 控制面核对。

## Spec Patch

无。已确认的边界和验收场景已包含在 OpenSpec delta specs 中。
