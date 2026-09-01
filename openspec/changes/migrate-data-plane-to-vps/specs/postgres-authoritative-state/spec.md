## ADDED Requirements

### Requirement: 权威状态必须使用标准 PostgreSQL 契约
系统 MUST 仅通过 direct/session-preserving TLS `DATABASE_URL` 访问 PostgreSQL，并使用版本化 SQL migrations 管理 collection、subject media、calendar、sync run、publication 和 migration 状态，不得依赖供应商专有 API。支持基线为受维护的 PostgreSQL `18.x`；未来 major 只能在显式评审和新的 real-server integration 后采用。PostgreSQL 17 compatibility 未验证。transaction pooling 不得用于 migration 或 session advisory lock，因为它不能保持数据库 session。

#### Scenario: 更换托管 PostgreSQL 供应商
- **WHEN** 运维导入标准 PostgreSQL dump 并替换 `DATABASE_URL`
- **THEN** 同步程序无需代码或 schema 变更即可运行

#### Scenario: session advisory lock requires a session-preserving connection
- **WHEN** 运维为 `DATABASE_URL` 选择连接端点
- **THEN** 使用 direct/session-preserving endpoint，而不是 transaction pooling endpoint

### Requirement: 完整数据变更必须事务提交
系统 MUST 在完整输入验证通过后于单个事务内应用新增、真实更新和确认删除，并不得持久化 Bangumi token、飞书 Webhook 或 R2 credential。

#### Scenario: transaction 提交前异常
- **WHEN** collection 已写入但 calendar 写入失败
- **THEN** 整个权威状态事务回滚且上一版数据保持不变

#### Scenario: collection 与 calendar 提供同一 subject
- **WHEN** 完整抓取中 calendar 明确提供某字段且 collection subject 同字段冲突，同时 calendar 省略其他字段
- **THEN** 规范化权威输入保留 calendar 冲突字段，并只用 collection 补齐 calendar 省略字段；collection-only、calendar-only 与跨用户重复 subject 均稳定保留

### Requirement: 删除必须以完整观测为前提
系统 MUST 仅在目标账户全部分页和 calendar 成功获取后确认缺失记录；截断或空页异常不得转化为删除。

#### Scenario: 未达到 total 时返回空页
- **WHEN** 已读取数量小于 total 而上游返回空 data
- **THEN** 本轮失败且数据库中既有收藏不得被删除
