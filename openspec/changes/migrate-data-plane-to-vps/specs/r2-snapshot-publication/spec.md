## ADDED Requirements

### Requirement: 公开 snapshot 必须规范化且不可变
系统 MUST 对不含运行时噪声的规范 JSON 计算 SHA-256，并使用 `snapshots/v1/<generation>-<sha256>.json` 保存不可变对象。

#### Scenario: 相同业务内容再次同步
- **WHEN** 新规范 payload hash 等于当前已发布 hash
- **THEN** 系统不增加 generation、不写 snapshot 且不更新 manifest

### Requirement: manifest 必须最后原子切换
系统 MUST 先上传 snapshot、回读并校验 hash，再覆盖 `public/manifest.json`；manifest MUST 包含 schema_version、generation、snapshot_key、content_sha256、published_at、source_observed_at、item_count 和 git_sha。

#### Scenario: snapshot 回读校验失败
- **WHEN** 上传对象缺失、截断或 hash 不匹配
- **THEN** 当前 manifest 保持不变且本次 publication 可安全重放

### Requirement: generation 必须单调递增
系统 MUST 在 PostgreSQL 中串行分配 generation，并拒绝较旧 run 覆盖较新 manifest。

#### Scenario: 较旧任务晚完成
- **WHEN** generation 9 在 generation 10 已发布后尝试切换 manifest
- **THEN** generation 9 被标记 obsolete 且 manifest 继续指向 generation 10
