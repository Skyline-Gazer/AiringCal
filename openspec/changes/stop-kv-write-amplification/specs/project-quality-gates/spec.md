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
