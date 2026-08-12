---
comet_change: harden-workflow-request-budget
role: technical-design
canonical_spec: openspec
---

# Workflow 请求预算硬化技术设计

## 1. 目的与范围

每日同步必须在 Cloudflare Workers Free Plan 的外部 fetch 与 Cloudflare 内部 service subrequest 限额内完成任意数量已配置用户的完整 collections 分页、calendar、准备、刷新和发布。此前只在 refresh planning 中插入 sleep，不能保护它之前随用户数和页数线性增长的抓取与准备工作。

本变更不改变公开读取、legacy snapshot、媒体预算、Queue payload、D1/R2 发布顺序或 shadow 隔离。它不限制用户数、不跳过页、不持久化 token、上游响应体或原始错误。

## 2. 预算模型

新增纯 typed `InvocationBudget`。每个 Workflow invocation 创建一个账本，分别计算：

- `external`: 对 bgm.tv 的网络 fetch；
- `internal`: KV、Durable Object、Queue、D1、R2 及 Workflow 所使用的 Cloudflare service 调用。

预算常量、每项操作成本和终态预留量在实现前必须由当前官方限制、本地 Worker 类型和实际调用点核实。调用点只能经 ledger wrapper 使用预算；wrapper 在发出副作用前拒绝超过相应预算的工作。每一个工作组同时预留 continuation 写入及 terminal error 所需的容量，不能指望同一耗尽 invocation 的 catch 记录错误。

## 3. Durable 数据与阶段

每个 instance 使用版本化 `FetchContinuationManifestV1` staging key。它只包含 instance ID、冻结的 `started_at`、当前阶段、已完成的 `(user, collectionType, page)` 标识、后续游标/总页数、calendar 完成标记、页摘要和完整性 hash。manifest 不记录 token、原始响应、完整上游错误或可变 latest pointer。

Workflow 采用新版本化 step 前缀；任一 continuation 仅以 Workflow durable step history 和 manifest 重建。在成功持久化本组页摘要及进度后执行确定性 `step.sleep`，让下一 invocation 从下一个未完成工作项继续。重放已完成 step 或 manifest 中存在的页必须直接复用结果，不再次 fetch 或写 staging。

旧实例保留其旧 step history；新的拓扑仅用于新 instance，避免历史 step 名冲突。

## 4. 执行流

1. 初始化 run，冻结 `started_at`。
2. collections fetcher 先按预算选择一组确定性页；发现分页信息后继续产生后续工作。到边界先保存 manifest，再 durable sleep。
3. collections 全部成功后，在独立有外部预算的组中取得 calendar；任一分页或 calendar 最终失败直接进入 terminalization，不进入 prepare。
4. prepare 从经过完整性验证的 manifest/staging 重建完整输入。缺页、重复页、schema/hash 不匹配均 fail closed。
5. live refresh planner 继续按内部预算切组；始终使用 `run.started_at` 计算 due，因此休眠、重试和 replay 不改变候选、reservation 或媒体 job ID。
6. reservation、commit、finalize 各在有内部预留的边界执行。shadow 保持其既有无 Queue 副作用语义。
7. 任意阶段最终失败时，进入专门保留预算的 terminalization continuation，写入脱敏分类 error 和非 running 状态；不发布部分 snapshot，也不推进删除判断。

## 5. 完整性与失败语义

只有 manifest 表明全部要求的 collections 页和 calendar 都完整成功，才允许 prepare、删除判断、D1 提交或正式 snapshot 发布。部分页永远只是 instance staging；上一版正式 snapshot 保持可读。

每次持久化前验证 manifest schema、页面唯一性、计数和 aggregate hash。任何验证失败或最终重试耗尽都会保留旧正式状态，并由 terminalization 记录分类错误。若 terminalization 自身临时失败，Workflow 继续按其独立、可重放的 step 重试；成功前不得伪造成功或清除 run 记录。

## 6. 兼容性与观测

`sync:run:<instance>` 继续是当前 run 的权威观测记录。新增的预算/continuation 元数据仅记录有界、脱敏计数和位置，health 只能经严格 schema 校验后显示。不会写共享的可变 shadow latest-pointer，也不会改变公开 read route。

部署采用新的 step/manifest 版本；回滚只部署上一兼容 SHA，不删除 KV、D1、R2、Queue 或 staging 数据。

## 7. 测试策略

- 用可重入的 Workflow fake 模拟 hibernate/resume，按 invocation 分别统计 external 与 internal 调用。
- 覆盖多个用户、50+ collections 页、calendar 与 prepare；每次 invocation 必须低于两类预算，完整输入只在全部页成功后出现。
- 覆盖 continuation replay：已完成页不重抓、不重复 staging 写；planner 的候选、reservation 与 job ID 在睡眠前后相同。
- 覆盖分页失败、manifest 损坏、预算尾部 staging/run-state 写失败和 terminalization；均不发布部分 snapshot，最终为可观测非 running error。
- 运行 sync-worker 定向测试、全仓 test/typecheck/build dry-run、OpenSpec strict validate；部署后再以 manual shadow 和 live Workflow 验证真实计数与公开 legacy smoke。

## 8. 风险与取舍

更多 durable steps 会增加恢复延迟，但按实际预算批处理，而非每页或每个 refresh chunk sleep，可使调用量远低于固定粒度方案。账本漏记新调用是主要回归风险，因此类型包装、调用点扫描和预算边界测试是强制门禁。
