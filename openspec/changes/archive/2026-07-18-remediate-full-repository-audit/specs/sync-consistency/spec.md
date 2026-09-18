## ADDED Requirements

### Requirement: 章节收藏同步必须完整分页
系统 MUST 以 bgm.tv 允许的 `limit=1000` 循环 offset 读取章节收藏，直到已读取数量达到响应 `total`。

#### Scenario: 账户有超过一千个章节收藏
- **WHEN** 上游报告 1001 个章节收藏
- **THEN** compare/apply 使用全部 1001 个结果而不是只使用第一页

#### Scenario: 未达到 total 时上游返回空页
- **WHEN** 已累计结果少于 `total` 且下一页 `data` 为空
- **THEN** 系统以明确上游分页错误终止，不得无限循环或返回截断成功结果

### Requirement: 章节写入必须分批并报告部分失败
系统 MUST 将 episode ID 按每批最多 100 个执行 PATCH，并在任一批失败时报告 partial/error 与失败批次，不得宣称静默成功。

#### Scenario: 第二批 PATCH 失败
- **WHEN** 第一批成功而第二批返回错误
- **THEN** 响应明确报告已成功与失败批次并且整体不为完整成功

### Requirement: compare 认证失败不得返回空成功结果
任一账户认证失败时 compare MUST 返回明确非 200 认证错误；双账户失败不得返回空的成功比较。

#### Scenario: 两个 Token 都无效
- **WHEN** compare 的源和目标账户均返回认证失败
- **THEN** endpoint 返回非 200 且包含稳定认证错误码
