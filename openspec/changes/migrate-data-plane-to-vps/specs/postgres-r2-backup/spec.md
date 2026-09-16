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
系统 MUST 提供纯函数保留策略，识别最近 30 个每日备份和更早每月最后一个归档之外的候选 key，并提供恢复到空数据库的校验流程。当前 change MUST NOT 自动发送 R2 Delete 请求；实际删除 R2 历史对象需要单独获批的 OpenSpec change。

#### Scenario: 保留策略只返回候选项
- **WHEN** retention 输入列表包含符合 backup-key grammar 的过期 key
- **THEN** selector 返回候选 key 但不删除对象；若 list/key 解析不确定则不返回任何删除候选

#### Scenario: 执行恢复演练
- **WHEN** 运维下载一个保留中的 dump 并恢复到空库
- **THEN** schema、核心行数和重新生成的 snapshot hash 均通过校验；除 PostgreSQL 未保存的 weekday display labels 与历史数组 ordering/identity indexes 外，snapshot 字段均从恢复数据库重建。labels/order metadata 只能取自 restored `publications.verified` 指向、且通过 key、canonical bytes 和 content-hash 校验的 immutable R2 snapshot；baseline 业务值不得直接信任，身份缺失、额外或不匹配时验证失败。
