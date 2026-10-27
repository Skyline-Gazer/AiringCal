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
