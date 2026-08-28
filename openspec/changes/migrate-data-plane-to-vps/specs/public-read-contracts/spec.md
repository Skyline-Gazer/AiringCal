## ADDED Requirements

### Requirement: 公开读取必须验证 R2 manifest 与 snapshot
Read Worker MUST 读取 `public/manifest.json`，验证 schema、单调 generation、snapshot key、SHA-256 和 payload 契约后才服务；失败时 MUST 依次使用最后验证 Cache API 副本和迁移期 legacy KV 整套快照。

#### Scenario: manifest 指向截断 snapshot
- **WHEN** R2 snapshot JSON 无法解析或 hash 不匹配
- **THEN** Read Worker 不服务损坏数据并使用最后验证副本或 legacy 整套 fallback

#### Scenario: manifest generation 回退
- **WHEN** R2 manifest generation 低于最后验证 generation
- **THEN** Read Worker 拒绝回退 manifest 并继续服务最后验证版本

### Requirement: 公开请求不得依赖 VPS 或 PostgreSQL
正常和降级的公开读取 MUST 只使用 Cloudflare 内部 R2、Cache API 与迁移期 KV，不得访问 VPS 或 `DATABASE_URL`。

#### Scenario: VPS 离线
- **WHEN** VPS 和托管 PostgreSQL 均不可达但已有有效 R2 snapshot
- **THEN** 公开页面和 API 继续返回该 snapshot
