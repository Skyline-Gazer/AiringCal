# Comet Design Handoff

- Change: secure-management-api
- Phase: design
- Mode: compact
- Context hash: 4cf752db3ed79a52efeb8da8a21ca9472e30982112dbbf58314b6f8526689876

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/secure-management-api/proposal.md

- Source: openspec/changes/secure-management-api/proposal.md
- Lines: 1-25
- SHA256: 04fbbd0c23aebcde9beb8d016c2ac4086fd603bf31c409dc35f132372b92d92e

```md
## Why

管理 API 当前在未配置 `MANAGE_SECRET` 时默认放行，并且 OAuth state、跨域策略、回调消息和 HTML 渲染缺少必要的安全边界。这使公开部署可能暴露 token 持久化、账户比较和收藏写回能力，必须先于其他修复收紧。

## What Changes

- **BREAKING**：管理写操作在未配置或未提供有效管理凭据时一律拒绝，不再保留“未配置则放行”的兼容行为。
- 将公开 API 与管理 API 的 CORS 策略分离，禁止任意跨域调用管理端点。
- 使用一次性、不可预测且可验证的 OAuth state，并限制回调消息的来源和接收窗口。
- 对管理页动态内容和服务端错误进行安全渲染，避免把外部数据直接拼入 `innerHTML`。
- 对健康接口返回值做最小披露，并采用适合 Workers 的安全比较和错误响应。

## Capabilities

### New Capabilities

- `management-api-security`: 管理端鉴权、OAuth 请求关联、跨域边界、安全输出和敏感信息最小披露。

### Modified Capabilities

无。

## Impact

影响 Worker 路由、中间件、管理页脚本、OAuth 回调、健康检查、部署 secrets 文档和相关测试。现有未配置 `MANAGE_SECRET` 的部署必须先配置管理凭据才能继续使用管理功能。
```

## openspec/changes/secure-management-api/design.md

- Source: openspec/changes/secure-management-api/design.md
- Lines: 1-41
- SHA256: f903d3c1d6a1adaaf559ca6f90b78cda9c0d254276bb74371490c6ba724ad5b1

```md
## Context

当前 Hono 应用用一个全局 CORS 中间件覆盖公开与管理路由，管理鉴权在 secret 缺失时放行；OAuth state 由客户端固定传入，token 通过 GET 查询参数交换并直接返回浏览器。修复必须保持单 Worker 架构，不增加独立认证服务。

## Goals / Non-Goals

**Goals:**

- 让管理能力默认关闭，只有正确配置后才可用。
- 补齐 OAuth 请求关联、浏览器消息来源验证和安全渲染。
- 保留公开 Widget API 的跨域读取能力。

**Non-Goals:**

- 不实现多用户管理后台、账户系统或权限角色。
- 不引入第三方身份服务。

## Decisions

- 在管理路由组上统一执行强制鉴权；配置缺失返回 503，凭据错误返回 401。
- 公开 API 保留允许跨域 GET，管理 API 仅同源，并避免在 URL 中传递管理 secret。
- OAuth state 由 Worker 生成，包含随机 nonce、用途和过期时间，并用从 `MANAGE_SECRET` 派生的 HMAC 密钥签名；不新增 KV 或 Durable Object 状态。
- code 交换改用受保护 POST；普通账户 token 仅返回当前页面，cron token 直接写入现有 `bgm:tokens` KV key 且不返回浏览器。
- 管理 secret、账户 A/B access token 和当前 OAuth 请求关联信息仅保存在管理页内存。
- 管理页使用 DOM API 和 `textContent` 构造动态内容。
- 健康接口对外只保留状态摘要，详细错误留在结构化日志。

## Risks / Trade-offs

- [已有部署未配置 secret 后管理页不可用] → README 和部署检查明确要求先配置。
- [无状态 state 无法由服务端记录“已消费”] → 管理页校验当前 nonce 和授权窗口，上游 authorization code 仍只能成功交换一次；重复请求不得持久化或返回新 token。
- [页面刷新会丢失管理 secret 和账户 token] → 这是避免浏览器持久化管理凭据的预期行为，刷新后重新输入和授权。
- [普通字符串 secret 比较存在时序差异] → 使用固定长度摘要后进行时间安全比较。

## Migration Plan

先配置 `MANAGE_SECRET`，再部署新代码；验证管理端拒绝无凭据请求并完成一次 OAuth 流程。异常时回滚代码，不删除现有 token 数据。

## Open Questions

无。
```

## openspec/changes/secure-management-api/tasks.md

- Source: openspec/changes/secure-management-api/tasks.md
- Lines: 1-17
- SHA256: 93000f1f4052cdbc89eae91e9ede3e84dd683f73222efd6bb4d3bf8049ff6177

```md
## 1. 安全边界

- [ ] 1.1 为管理路由建立默认拒绝的统一鉴权与配置检查
- [ ] 1.2 分离公开 API 与管理 API 的 CORS 和安全响应头
- [ ] 1.3 收紧公开健康接口并改为结构化内部日志

## 2. OAuth 与浏览器安全

- [ ] 2.1 实现签名 OAuth state 的生成、签名、时效、用途和 nonce 验证
- [ ] 2.2 将 token 交换改为受保护的 POST 请求并验证输入
- [ ] 2.3 限制回调 `postMessage` 的来源、目标和窗口关联
- [ ] 2.4 将管理页动态 HTML 改为安全 DOM/文本渲染

## 3. 验证与文档

- [ ] 3.1 添加鉴权、state、CORS 和安全渲染检查
- [ ] 3.2 更新部署 secrets 与管理页使用文档
```

## openspec/changes/secure-management-api/specs/management-api-security/spec.md

- Source: openspec/changes/secure-management-api/specs/management-api-security/spec.md
- Lines: 1-51
- SHA256: 62e4725b2dc09640a246743b320bce8fc06f094bfeb911559caebf6d197469da

```md
## ADDED Requirements

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
```
