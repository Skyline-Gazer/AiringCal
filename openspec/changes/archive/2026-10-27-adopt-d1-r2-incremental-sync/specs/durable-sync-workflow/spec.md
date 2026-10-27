## ADDED Requirements

### Requirement: Workflow 必须增量提交 D1 状态
Workflow MUST 在成功获取全部 collections 与 calendar 后对 D1 当前状态执行内存 diff，并只提交新增、真实变化与合法状态转换。

#### Scenario: 业务内容完全相同
- **WHEN** 每日全量读取成功且所有规范 hash 与 D1 相同
- **THEN** collection_items 产生零行写入且 Workflow 仍记录成功摘要

### Requirement: Workflow 必须发布可验证 R2 候选
Workflow MUST 在 D1 状态提交后构建 `PublicSnapshotV1`，并仅在内容 hash 变化时执行 R2 与 pointer 发布协议。

#### Scenario: D1 成功但 R2 写入失败
- **WHEN** 新公开内容已提交到 D1而 R2 PUT 失败
- **THEN** Workflow 记录可重试错误且旧 KV pointer 不变
