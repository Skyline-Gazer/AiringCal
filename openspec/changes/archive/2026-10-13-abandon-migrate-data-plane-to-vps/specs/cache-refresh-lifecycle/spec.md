## ADDED Requirements

### Requirement: 媒体生产者必须唯一
VPS 同步运行时 MUST 是 detail、metadata、image 与 R2 图片对象的唯一正式生产者；Cloudflare Read Worker MUST 只读取 snapshot 与内容寻址图片，不得抓取上游、更新 PostgreSQL 或写入图片对象。

#### Scenario: 图片未命中公开缓存
- **WHEN** Read Worker 收到一个有效 snapshot 图片 URI 且边缘缓存未命中
- **THEN** Read Worker 仅从 R2 读取内容并返回缓存响应，不调用 bgm.tv 或产生 R2 PUT

#### Scenario: 从 shadow 切换到 live
- **WHEN** VPS shadow 验证通过并准备成为正式媒体生产者
- **THEN** 旧 Cloudflare Media Queue consumer 在 live 切换前停止，避免出现两个正式写者

## MODIFIED Requirements

### Requirement: subject 缓存必须支持过期继续服务
subject detail、metadata 或 image 到期时，公开读取 MUST 继续服务 PostgreSQL/R2 中最后成功版本，VPS 同步任务在后台刷新且失败不得清空旧值。

#### Scenario: detail 已进入刷新窗口
- **WHEN** subject detail 已到刷新时间但仍有上次成功值
- **THEN** 公开 snapshot 继续包含旧值且本轮任务尝试刷新

### Requirement: subject 刷新时间必须分散
系统 MUST 使用 subject ID 与稳定周期计算确定性刷新分片，避免单次日任务同时刷新所有稳定 subject。

#### Scenario: 一百个 subject 同时写入
- **WHEN** 一百个 subject 首次进入 PostgreSQL
- **THEN** 后续刷新时间按稳定分片分散而不是全部同日到期

#### Scenario: subject 尚未到期
- **WHEN** 已缓存 subject 内容未变化且刷新时间未到
- **THEN** 同步任务不调用对应上游详情或图片接口

### Requirement: Media Queue 消息必须可去重
每个媒体刷新 MUST 由稳定 run ID、subject ID 与观察时间标识；PostgreSQL 唯一约束和状态转换 MUST 阻止重放产生重复下载或 R2 写入。

#### Scenario: 同一 run 重放
- **WHEN** 同一 subject 的媒体阶段因任务恢复再次执行
- **THEN** 已完成状态被复用且不重复下载或覆盖图片

### Requirement: 刷新状态与图片结果必须分离
系统 MUST 在 PostgreSQL 分别保存 detail、metadata、image 与 refresh 结果；缺少图片 URL 不得把成功 metadata 标记失败。

#### Scenario: metadata 成功但图片缺少源 URL
- **WHEN** subject metadata 可用而图片 URL 缺失
- **THEN** metadata 被提交且 image 状态记录为明确缺失

### Requirement: Media Queue 重试必须区分瞬态与终态
VPS 媒体刷新 MUST 区分可重试网络/上游错误与 404 等终态，并使用持久化 next_retry_at 防止每轮无界重试。

#### Scenario: 图片上游暂时返回 503
- **WHEN** 图片下载返回 503
- **THEN** 旧图片继续服务且记录有界退避时间

#### Scenario: subject 不存在
- **WHEN** bgm.tv 明确返回 404
- **THEN** 系统记录保守 tombstone 且不按瞬态错误立即重试

### Requirement: subject 副作用必须按 generation 串行
系统 MUST 使用 PostgreSQL advisory/row lock 和观察时间围栏串行执行同一 subject 的 detail、metadata、image 与 refresh 副作用，并拒绝过期写入。

#### Scenario: 旧刷新晚完成
- **WHEN** 较旧 observed_at 的刷新在较新状态提交后返回
- **THEN** 旧结果标记 obsolete 且不得覆盖 PostgreSQL 或 R2

#### Scenario: 迁移期旧 Worker 与 VPS 共存
- **WHEN** shadow 期间旧媒体 Worker 仍可能运行
- **THEN** VPS shadow 不切换公开 manifest，切流前停止旧 consumer 以建立单一写者

### Requirement: subject 404 必须建立保守 tombstone
确认 subject 404 后 PostgreSQL MUST 保存有期限 tombstone；网络错误不得创建 tombstone，期限内不得重复抓取。

#### Scenario: 已缓存 subject 后变成 404
- **WHEN** 权威详情接口明确返回 404
- **THEN** 系统保留最后成功公开数据并记录 tombstone 到期时间

#### Scenario: tombstone TTL 内再次同步
- **WHEN** 下一轮任务发生在 tombstone 到期前
- **THEN** 系统不重复请求该 subject 详情

#### Scenario: 上游网络或服务错误
- **WHEN** 请求因 timeout、429 或 5xx 失败
- **THEN** 系统保留旧数据并记录可重试状态而非 tombstone

### Requirement: 相同媒体状态不得重复写入
系统 MUST 在写 PostgreSQL 或 R2 前比较规范媒体内容；可复用且未变化时不得执行对应 UPDATE 或 object PUT。

#### Scenario: 图片与 metadata 均可复用
- **WHEN** hash、来源和刷新状态与权威记录相同
- **THEN** 本轮不产生媒体行更新或图片 PUT
