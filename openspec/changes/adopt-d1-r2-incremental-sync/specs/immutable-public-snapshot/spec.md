## ADDED Requirements

### Requirement: 公开 snapshot 必须是不可变单对象
系统 MUST 将完整 collections、calendar 与 summary 作为 `PublicSnapshotV1` 写入 `snapshots/v1/{generation}-{content_hash}.json`。

#### Scenario: 公开内容发生变化
- **WHEN** D1 commit 后规范公开 payload hash 不同于当前版本
- **THEN** 系统写入一个新 R2 对象且不覆盖旧 generation

### Requirement: 未变化内容必须零发布写入
系统 MUST 排除 generation 与发布时间后计算规范 content hash；hash 相同时不得写 R2、增加 generation 或更新 KV pointer。

#### Scenario: 无变化日同步
- **WHEN** 收藏、calendar 与公开媒体投影均与当前 snapshot 相同
- **THEN** R2 PUT 与 KV PUT 均为零

### Requirement: pointer 必须最后原子切换
系统 MUST 在 D1 commit、R2 PUT 与 R2 回读校验全部成功后，以单次 KV PUT 更新 `public:current`。

#### Scenario: R2 回读校验失败
- **WHEN** 新对象的 schema、generation 或 hash 与候选 pointer 不一致
- **THEN** 当前 pointer 保持不变且旧 snapshot 继续可用
