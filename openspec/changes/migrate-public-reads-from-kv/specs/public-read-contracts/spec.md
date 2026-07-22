## ADDED Requirements

### Requirement: 公开读取必须验证 R2 snapshot
Read Worker MUST 验证 `public:current`、支持的 schema version、generation 与 content hash 后才使用 R2 snapshot，并保持现有 API JSON 与分页契约。

#### Scenario: pointer 指向未知 schema
- **WHEN** `public:current` 的 schema version 不受支持
- **THEN** Read Worker 不使用该对象并执行兼容 fallback

### Requirement: 公开读取必须有两级 fallback
R2 snapshot 验证或读取失败时，Read Worker MUST 先使用 Cache API 中最后已验证版本；不存在时 MUST 回退旧 KV manifest。

#### Scenario: R2 暂时返回错误
- **WHEN** 当前 pointer 有效但 R2 GET 失败且缓存存在
- **THEN** API 返回最后已验证缓存版本且记录降级状态

### Requirement: health 必须暴露迁移与预算摘要
`/api/health` MUST 在不移除既有字段的前提下增加当前 generation、snapshot source、D1 budget 与 legacy migration 摘要。

#### Scenario: 系统仍处于 shadow 阶段
- **WHEN** 尚未满足七次一致门禁
- **THEN** health 返回旧读取 source、shadow streak 与迁移游标摘要
