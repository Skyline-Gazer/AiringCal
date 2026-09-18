## ADDED Requirements

### Requirement: 公开读取必须验证 R2 manifest 与 snapshot
Read Worker MUST 读取并验证 `public/manifest.json` 指向的完整 snapshot。只有当前请求能够读取 `last-verified` pointer 并重新验证其 `{ manifest, snapshot }` 整对时，才 MUST 相对于该整对的 generation/hash 拒绝较低 generation 或同代不同 hash 的 R2 manifest，并可使用该整对作为 fallback；否则不得声称已观察到其他 isolate 或 POP 的最新 generation。R2 与有效 envelope 均不可用时，迁移期 MUST 使用完整 legacy KV snapshot；来源字段不得混合。Cache API 内容不会复制到来源 data center 之外，且可能缺失、过期或被逐出；写入队列只在单个 Worker isolate 内串行，Cache API 没有跨 isolate 的共享原子 compare-and-swap。因此跨 isolate/POP 的 rollback protection 为 best effort，不提供 global monotonic-generation guarantee。

#### Scenario: manifest 指向截断 snapshot
- **WHEN** R2 snapshot JSON 无法解析或 hash 不匹配
- **THEN** Read Worker 不服务损坏数据；若当前请求能读取并重新验证 `last-verified` envelope，则使用它，否则回退到完整 legacy KV snapshot

#### Scenario: 可观察 envelope 内的 manifest generation 回退
- **WHEN** 当前请求读取并重新验证了 `last-verified` envelope，而 R2 manifest generation 低于该 envelope，或同一 generation 使用不同 hash
- **THEN** Read Worker 拒绝该较旧或冲突的 manifest 并继续服务这个已重新验证的 envelope

#### Scenario: Cache API 不可观察到先前 envelope
- **WHEN** 当前请求无法读取或重新验证 `last-verified` envelope，且 R2 返回较旧 manifest
- **THEN** Read Worker 不宣称已检测到全局 rollback；跨 isolate/POP 的保护为 best effort

### Requirement: 公开请求不得依赖 VPS 或 PostgreSQL
正常和降级的公开读取 MUST 只使用 Cloudflare 内部 R2、Cache API 与迁移期 KV，不得访问 VPS 或 `DATABASE_URL`。

#### Scenario: VPS 离线
- **WHEN** VPS 和托管 PostgreSQL 均不可达但已有有效 R2 snapshot
- **THEN** 公开页面和 API 继续返回该 snapshot
