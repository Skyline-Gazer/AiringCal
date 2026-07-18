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

