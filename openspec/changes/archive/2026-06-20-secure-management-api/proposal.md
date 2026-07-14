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
