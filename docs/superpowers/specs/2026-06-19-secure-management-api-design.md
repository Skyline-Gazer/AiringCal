---
comet_change: secure-management-api
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-20-secure-management-api
status: final
---

# Secure Management API 技术设计

## 目标与边界

本变更收紧现有单 Worker 管理面，不引入账户系统、Cloudflare Access、Durable Object 或新的持久化结构。能力需求和验收场景以 OpenSpec 的 `management-api-security` delta spec 为准；本文只描述实现方式。

保留公开 `/manage` 页面和公开只读 API。所有 `/api/manage/*` 能力默认拒绝，只有部署已配置 `MANAGE_SECRET` 且请求携带正确凭据时才执行。

## 组件调整

实现保持在现有 Worker 内，新增最少量的纯函数安全辅助代码：

- `packages/worker/src/index.ts`：路由分组、管理鉴权、同源检查、安全响应、健康接口和 OAuth 流程编排。
- `packages/worker/src/manage/oauth.ts`：OAuth URL、签名 state 的生成和验证、code 交换。
- `packages/worker/src/manage/index.html`：仅内存凭据、弹窗关联、回调校验和安全 DOM 渲染。
- 如 `index.ts` 继续膨胀，可将可独立测试的鉴权/state 辅助函数放入一个 `manage/security.ts`；不建立额外中间件框架或抽象层。

## 管理 API 安全边界

### 强制鉴权

管理路由统一执行以下顺序：

1. `MANAGE_SECRET` 缺失或为空时返回 `503`，错误码为 `MANAGE_NOT_CONFIGURED`。
2. 检查 `X-Manage-Secret`；缺失或不匹配时返回 `401`，错误码为 `UNAUTHORIZED`。
3. 请求带 `Origin` 时，它必须等于当前请求 URL 的 origin；不匹配时返回 `403`。无 `Origin` 的非浏览器调用仍需通过 secret 鉴权。
4. 通过检查后才解析请求体、访问 KV、调用 bgm.tv 或执行同步。

secret 比较不直接比较可变长度字符串。双方先以 SHA-256 转为固定 32 字节摘要，再用固定 32 次循环累积 XOR 差异并一次性判断结果，避免长度和首个不同字符造成明显时序差异。

`/api/manage/gate` 不再公开暴露是否配置 secret。管理页直接显示密码输入框，首次受保护请求根据 `503` 或 `401` 展示对应提示。

### CORS 与响应头

移除覆盖全站的 `origin: *` 中间件：

- `/api/collections`、`/api/calendar`、`/api/config` 和 `/api/health` 保留公开 GET 所需的跨域读取。
- `/api/manage/*` 不返回第三方 `Access-Control-Allow-Origin`，预检只允许当前 origin、必要方法以及 `Content-Type`、`X-Manage-Secret`。
- 管理 API、`/manage` 和 `/manage/callback` 返回 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。
- 管理页 CSP 仅允许同源连接、HTTPS/data 图片以及当前内联脚本和样式；回调页 CSP 只允许自身内联脚本，并禁止 frame、base 和 form。

## OAuth state

### 格式

state 使用无服务端存储的版本化格式：

```text
base64url({"v":1,"nonce":"...","purpose":"account-a|account-b|cron","exp":...}).base64url(hmac)
```

- `nonce`：Worker 生成至少 128 bit 的随机值。
- `purpose`：只允许 `account-a`、`account-b`、`cron`。
- `exp`：短期 Unix 时间戳，建议 5 分钟。
- HMAC：SHA-256；密钥由 `MANAGE_SECRET` 加固定上下文字符串派生，防止未来把同一 secret 直接复用于其他签名协议。

验证时先限制 state 总长度，再解析两个分段；校验版本、字段类型、purpose、过期时间和 HMAC。签名比较使用固定长度字节比较。任何失败都返回统一的 `INVALID_OAUTH_STATE`，不暴露具体签名信息。

### 发起授权

`POST /api/manage/oauth-url` 受管理鉴权保护，请求体只含 `purpose`。Worker 生成 state，并返回：

```json
{ "url": "...", "state": "...", "nonce": "..." }
```

管理页把本次 `state`、`nonce`、`purpose` 和 `window.open()` 返回的窗口引用仅保存于页面内存。每个时刻只保留当前授权请求；开始新请求时替换旧请求。

### 回调关联

`/manage/callback` 从 URL 读取 `code` 和 `state`，只向 `location.origin` 调用 `window.opener.postMessage`，不使用 `"*"`。页面不交换 token，也不持久化数据。

管理页只接受同时满足以下条件的消息：

- `event.origin === location.origin`；
- `event.source === 当前保存的弹窗引用`；
- 消息类型、code 和 state 都是预期类型；
- state 与当前请求完全一致，解析出的 nonce 和 purpose 与内存记录一致。

不匹配的消息直接忽略。手工粘贴回调 URL 走同一 state、nonce 和 purpose 校验，不能只提取 code。

### 交换与 token 去向

`POST /api/manage/exchange` 受管理鉴权保护，请求体为 `{ code, state }`。服务端先验证 state，再调用 bgm.tv：

- `account-a`、`account-b`：仅返回当前比较流程需要的 `access_token` 和非敏感账户标识；不返回 `refresh_token`。access token 只写入页面内存。
- `cron`：将 access/refresh token 直接写入现有 KV key `bgm:tokens`，响应固定为 `{ "ok": true }`，不得包含任何 token。

重复提交同一 code 时依赖 bgm.tv 的一次性 code 语义失败；失败路径不得写入 KV，也不得返回旧 token。现有 `bgm:tokens` 结构不迁移。

## 管理页面数据处理

`manageSecret`、账户 A/B access token、当前 OAuth state/nonce 和弹窗引用都只存在于脚本变量中。删除 `sessionStorage` 和 `localStorage` 对管理凭据的读写；刷新页面后要求重新输入密码和重新授权账户。

固定的静态布局可以保留 HTML 模板。所有来自用户名、bgm.tv 条目、同步结果和服务端错误的数据通过 `createElement`、`textContent`、属性赋值和事件监听器构造，不拼接到 `innerHTML`。图片 URL 只赋给 `img.src`，并限制为 `https:` 或留空。

管理页错误展示只识别固定错误码和安全消息。未知服务端错误显示通用文案，不显示上游响应体、URL、堆栈或 token。

## 错误与日志

外部管理响应采用稳定结构：

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }
```

上游 401/403、超时、网络错误和未知异常映射为有限的安全错误码。响应不得带 bgm.tv 原始 body、secret、authorization code、access token、refresh token 或完整堆栈。

Worker 内部使用单条结构化 `console.error` 记录事件名、路由、上游状态、错误类别和请求时间。日志不记录请求头、请求体、state、code 或 token；自由文本错误先截断并去除已知敏感字段。

## 健康接口

`GET /api/health` 保持公开，但只返回：

- `ok`；
- 各收藏分类和总数；
- 收藏更新时间；
- calendar 天数；
- 最近成功同步时间。

删除 `BANGUMI_USERS` 和 `sync:last_error` 的公开输出。读取失败时返回通用失败状态；详细异常只进入已脱敏结构化日志。

## 验证策略

采用最小可运行检查覆盖安全分支：

1. 鉴权：未配置 secret 为 503；缺失和错误 secret 为 401；正确 secret 才进入处理器。
2. CORS：公开 GET 可跨域读取；第三方 origin 的管理请求没有授权 CORS 头并被拒绝。
3. state：有效 state 通过；篡改、过期、错误 purpose、错误 nonce 和超长输入失败。
4. OAuth 窗口：错误 origin、错误窗口引用和旧 state 消息被忽略。
5. token：cron exchange 只返回 `{ok:true}`；账户 exchange 不返回 refresh token；失败不改写 KV。
6. 渲染：包含标签和事件属性的用户名、条目名、同步错误只显示为文本。
7. 健康接口：响应中不存在用户名、详细错误、token 和敏感配置。

测试优先覆盖提取出的纯函数和 Hono `app.request()` 路由，不引入新的测试框架；若当前 Node 版本无法直接执行 TypeScript，则由 `restore-project-quality-gates` change 统一补齐测试运行器，本变更至少保留可由后续 runner 直接接入的测试文件和断言。

## 部署与回滚

部署顺序：

1. 在 Cloudflare 中配置非空 `MANAGE_SECRET`。
2. 部署新 Worker。
3. 验证无凭据、错误凭据和正确凭据三条路径。
4. 完成一次 cron OAuth，确认浏览器响应无 token 且现有 `bgm:tokens` 可被定时同步读取。
5. 完成账户 A/B 授权和比较，刷新页面确认凭据不会恢复。

回滚只回滚 Worker 代码，不删除或改写现有 `bgm:tokens`。如果必须回滚到旧代码，仍保留已配置的 `MANAGE_SECRET`，避免恢复为未配置即放行。

## 被否决方案

- Cloudflare Access、多用户账户和角色：超出个人部署需求与本变更范围。
- KV/DO 保存 OAuth state：为短期 CSRF 关联增加一致性和清理成本；签名 state、页面 nonce、窗口关联和上游一次性 code 已覆盖当前风险。
- 浏览器持久化管理 secret 或账户 token：便利性不足以抵消 XSS、共享设备和调试工具暴露风险。
