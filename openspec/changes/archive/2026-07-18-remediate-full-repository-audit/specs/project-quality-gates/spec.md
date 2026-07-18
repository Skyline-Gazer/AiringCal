## MODIFIED Requirements

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权、同步输入验证、Workflow 幂等发布、Queue 去重、部署业务解耦、公开输出编码、严格查询参数、章节分页/分批与 404 tombstone MUST 有可运行的自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试重复执行相同 enqueue step
- **THEN** 测试验证相同 `job_id` 不会产生重复媒体副作用

#### Scenario: 恶意数据进入公开 HTML
- **WHEN** 测试注入脚本标签、事件属性和 pre 结束标签
- **THEN** 测试验证输出不可执行且安全响应头完整

## ADDED Requirements

### Requirement: 资产生成链路必须防止副本漂移
质量门禁 MUST 验证 Widget 主题源码、生成产物和部署入口一致，并拒绝已删除的手工副本重新出现。

#### Scenario: 旧 Widget 副本被重新加入
- **WHEN** `assets/public` 或 `theme/v1` 再次包含部署资产副本
- **THEN** 自动检查失败并指向唯一源码链路
