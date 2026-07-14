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
