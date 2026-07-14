# Brainstorm Summary

- Change: secure-management-api
- Date: 2026-06-19

## 已确认事实

- 管理后台继续使用单一 `MANAGE_SECRET`。
- `MANAGE_SECRET` 从可选保护改为管理能力的强制前置条件。
- 不引入 Cloudflare Access、用户账户、角色或完整 session 登录系统。
- 管理密码仅保存在当前页面内存，刷新后必须重新输入；不得写入任何 Web Storage。
- 账户 A/B 的 OAuth access token 仅保存在当前管理页内存，刷新后失效。
- Cron 授权 token 由服务端直接写入现有 KV token key，浏览器只收到成功状态，不收到 token 值。
- 已确认认证与 OAuth 数据流：`/manage` 可加载，但管理 API 默认拒绝；缺失配置返回 503，错误凭据返回 401；OAuth URL 和 exchange 均受保护；管理 API 仅同源。
- 已确认输出安全与诊断：外部数据只通过文本节点渲染；回调与管理响应使用安全头；健康接口只返回非敏感摘要；详细错误进入结构化日志；secret 通过固定长度摘要做时间安全比较。

## 确认的技术方案

- 已确认：OAuth state 使用无服务端存储的签名载荷。
- 已确认：管理 secret 只保存在页面内存。
- 已确认：账户操作 token 只保存在页面内存；Cron token 不回传浏览器。
- 管理 API 采用强制共享 secret、同源限制和安全响应头。
- OAuth state 由随机 nonce、用途和过期时间组成，并使用从 `MANAGE_SECRET` 派生的 HMAC 签名。
- 管理页核对 origin、授权窗口引用和 nonce，使用受保护 POST 交换 code。
- 外部数据使用 DOM 文本节点渲染；公开健康接口仅返回非敏感摘要。

## 关键取舍与风险

- 共享 secret 适合当前个人部署规模，改动小且易于运维。
- 必须补齐同源限制、固定长度摘要比较和缺失配置时默认拒绝，避免共享 secret 方案继续处于软保护状态。
- 牺牲刷新后的便利性，换取不在浏览器持久存储管理凭据。
- OAuth state 包含随机 nonce、用途和过期时间，并使用从 `MANAGE_SECRET` 派生的 HMAC 签名。
- 管理页保留当前 nonce 与授权窗口引用；回调必须同时通过签名、时效、用途、nonce 和窗口来源检查。
- 不为 OAuth state 引入 KV 或 Durable Object。
- OAuth code 交换使用受保护的 POST；普通账户交换返回当前页面所需 access token，cron 交换只返回 `{ ok: true }`。

## 测试策略

- 验证未配置、缺失、错误和正确 secret 四条路径。
- 验证刷新后管理凭据不会从浏览器存储恢复。
- 验证签名篡改、过期、用途不匹配、nonce 不匹配和错误窗口均被拒绝。
- 验证 cron 授权响应不包含 access token 或 refresh token。
- 验证公开与管理 API 的 CORS 边界。
- 验证恶意用户名、条目名和错误消息只按文本显示。
- 验证健康接口不返回用户名和详细错误。

## Spec Patch

- 将 OAuth state 从“服务端一次性消费”澄清为“每次授权唯一、签名且短期有效”；重放由当前页面 nonce 校验和上游一次性 authorization code 共同阻断。
