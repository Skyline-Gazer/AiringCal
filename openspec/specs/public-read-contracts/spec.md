# public-read-contracts Specification

## Purpose
TBD - created by archiving change remediate-full-repository-audit. Update Purpose after archive.
## Requirements
### Requirement: health 在零收藏时必须返回完整状态
`/api/health` MUST 在收藏总数为零时仍返回 collections、cache、cron 与 workflow 数据。

#### Scenario: 新账户没有收藏
- **WHEN** snapshot summary 的总数为零
- **THEN** health 返回 200 和完整 `data`，不得提前返回空结构

### Requirement: cache 分页字段必须表达当前页数量
`/api/cache` MUST 使用 `page_subjects` 表达当前页数量，不得把分页结果标记为全局 `total_subjects`；cursor MUST 保持兼容。

#### Scenario: cache 返回第二页
- **WHEN** 客户端使用 cursor 请求下一页
- **THEN** `page_subjects` 等于当前页条目数且 next cursor 可继续使用

### Requirement: 公开读取参数必须严格验证
系统 MUST 完整验证 `type`、`page`、`limit` 与 `cursor` 字符串；未知枚举、尾随字符或畸形 cursor MUST 返回 400。

#### Scenario: page 含尾随字符
- **WHEN** 客户端请求 `page=2junk`
- **THEN** 系统返回 400 且不静默采用 page 2 或默认值

### Requirement: 公开读取必须验证 R2 snapshot
Read Worker MUST 验证 `public:current`、支持的 schema version、generation 与 content hash 后才使用 R2 snapshot，并保持现有 API JSON 与分页契约。

#### Scenario: pointer 指向未知 schema
- **WHEN** `public:current` 的 schema version 不受支持
- **THEN** Read Worker 不使用该对象并执行兼容 fallback

#### Scenario: R2 条目保留 legacy 响应字段
- **WHEN** `public:read-mode` 为 r2 且 R2 snapshot 验证通过
- **THEN** collections 与 calendar 条目必须包含与 legacy 响应相同的
  `image_status`（以及 collections 的 `rating`）字段，分页与 JSON shape 不变

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

