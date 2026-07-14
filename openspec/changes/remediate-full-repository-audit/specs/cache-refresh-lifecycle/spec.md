## ADDED Requirements

### Requirement: subject 404 必须建立保守 tombstone
subject detail 返回 404 时，系统 MUST 停止返回旧 detail，并写入带明确 TTL 的 `exists: false`、`nsfw: true`、`reason: not_found` tombstone。

#### Scenario: 已缓存 subject 后变成 404
- **WHEN** 刷新已缓存 subject 得到 404
- **THEN** 旧 detail 不再返回且读取端采用保守 NSFW 元数据

#### Scenario: tombstone TTL 内再次刷新
- **WHEN** 同一 subject 在 tombstone TTL 到期前再次进入刷新路径
- **THEN** 系统不重复请求 subject detail 上游
