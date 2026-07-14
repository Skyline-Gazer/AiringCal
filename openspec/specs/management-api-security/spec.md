# management-api-security Specification

## Purpose
TBD - created by archiving change secure-management-api. Update Purpose after archive.
## Requirements
### Requirement: 管理操作默认拒绝
系统 MUST 仅在服务端配置管理凭据且请求提供有效凭据时执行管理写操作或返回 OAuth token。

#### Scenario: 未配置管理凭据
- **WHEN** 部署未配置管理凭据且客户端调用任一受保护管理端点
- **THEN** 系统返回服务未安全配置的错误且不执行操作

#### Scenario: 凭据无效
- **WHEN** 请求未提供凭据或凭据不匹配
- **THEN** 系统返回未授权且不读取、写入或删除敏感数据

### Requirement: 管理端跨域隔离
系统 MUST 将公开读取 API 与管理 API 的跨域策略分离，管理 API 不得允许任意来源跨域调用。

#### Scenario: 第三方来源调用管理 API
- **WHEN** 非允许来源向管理 API 发起跨域请求
- **THEN** 响应不授予该来源跨域访问权限

### Requirement: OAuth 请求必须关联
每次 OAuth 授权 MUST 使用不可预测、请求唯一且有有效期的签名 state，并在交换 code 前验证签名、时效、用途和当前页面持有的 nonce。

#### Scenario: state 不匹配
- **WHEN** 回调 state 缺失、签名无效、过期、用途错误或 nonce 与当前授权请求不匹配
- **THEN** 系统拒绝交换 code

#### Scenario: state 被重复提交
- **WHEN** 同一授权 code 和 state 被再次提交
- **THEN** 上游一次性 code 交换失败且系统不得返回或持久化新 token

### Requirement: 浏览器消息来源必须验证
OAuth 回调页和管理页 MUST 限制 `postMessage` 的目标与来源，并确认消息来自本次打开的授权窗口。

#### Scenario: 非预期窗口发送消息
- **WHEN** 管理页收到来自其他来源或其他窗口的 OAuth 消息
- **THEN** 管理页忽略该消息

### Requirement: 外部数据安全渲染
管理页 MUST 将用户名、条目名和服务端错误视为不可信输入，不得未经转义拼接到可执行 HTML。

#### Scenario: 数据包含 HTML
- **WHEN** bgm.tv 数据或错误消息包含 HTML 标签或事件属性
- **THEN** 页面按纯文本展示且不执行脚本

### Requirement: 诊断信息最小披露
公开健康接口 MUST 只返回运行状态所需的信息，不得暴露用户名、token、内部错误详情或其他敏感配置。

#### Scenario: 公开读取健康状态
- **WHEN** 未认证用户请求健康接口
- **THEN** 响应仅包含布尔状态、非敏感计数和时间信息

