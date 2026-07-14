---
change: secure-management-api
design-doc: docs/superpowers/specs/2026-06-19-secure-management-api-design.md
base-ref: 3e346b78f4ca2833b8d6e3956bcbdb36d99c2721
archived-with: 2026-06-20-secure-management-api
---

# Secure Management API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将管理 API 改为默认拒绝，使用签名短期 OAuth state，并消除管理页凭据持久化、跨域调用、危险动态 HTML 和公开诊断泄漏。

**Architecture:** 保持单 Worker 和现有 KV token 结构。新增一个无依赖的 `manage/security.ts`，集中处理固定长度 secret 比较、管理请求鉴权、签名 state、安全响应头和回调页；`index.ts` 只负责路由编排，管理页只保存当前页面内存状态。

**Tech Stack:** TypeScript、Hono、Cloudflare Workers Web Crypto、Node 26 内置 `node:test`、Wrangler 4。

## Global Constraints

- 不新增 npm 依赖、认证服务、KV key、Durable Object、账户系统或角色系统。
- `MANAGE_SECRET` 缺失返回 `503 MANAGE_NOT_CONFIGURED`；缺失或错误凭据返回 `401 UNAUTHORIZED`。
- 所有 `/api/manage/*` 请求必须先通过鉴权与同源检查，再解析输入或访问 KV/上游。
- OAuth state 只包含版本、随机 nonce、用途和过期时间，使用从 `MANAGE_SECRET` 派生的 HMAC-SHA-256 签名，有效期固定 5 分钟。
- 管理 secret、A/B access token、state、nonce 和 popup 引用只保存在当前页面内存。
- cron token 继续写入 `bgm:tokens`；浏览器只能收到 `{ "ok": true }`。
- 公开读取 API 保留跨域 GET；管理 API 不授予第三方 CORS。
- 外部数据只通过 DOM 文本 API 渲染；服务端响应不包含上游 body、token、code、secret 或堆栈。
- 不修改 `package.json`、锁文件、工具目录或其他三个 OpenSpec change。

archived-with: 2026-06-20-secure-management-api
---

## File Map

- Create: `packages/worker/src/manage/security.ts` — 管理鉴权、签名 state、安全错误/头和 OAuth 回调 HTML。
- Create: `packages/worker/src/manage/security.test.ts` — Node 内置测试覆盖鉴权、state、头和回调目标。
- Modify: `packages/worker/src/index.ts` — 路由级 CORS、管理中间件、POST OAuth、token 去向、健康接口和脱敏日志。
- Modify: `packages/worker/src/manage/oauth.ts` — 保留 OAuth URL 与上游 code exchange，收紧返回类型。
- Modify: `packages/worker/src/manage/index.html` — 内存凭据、popup/state 关联和安全 DOM 渲染。
- Create: `packages/worker/src/manage/index-html.test.mjs` — 静态安全回归测试，不引入 DOM 测试库。
- Modify: `README.md` — 将 `MANAGE_SECRET` 改为强制配置并更新 OAuth 行为。
- Modify: `openspec/changes/secure-management-api/tasks.md` — 每个交付项验证后勾选。

### Task 1: 安全原语与签名 state

- [x] Task 1 complete: 安全原语与签名 state

**Files:**
- Create: `packages/worker/src/manage/security.ts`
- Create: `packages/worker/src/manage/security.test.ts`
- Modify: `openspec/changes/secure-management-api/tasks.md`

**Interfaces:**
- Produces: `OAuthPurpose = 'account-a' | 'account-b' | 'cron'`
- Produces: `createOAuthState(secret, purpose, now?) -> Promise<{ state, nonce }>`
- Produces: `verifyOAuthState(secret, state, now?) -> Promise<OAuthStatePayload | null>`
- Produces: `authorizeManageRequest(request, secret) -> Promise<Response | null>`
- Produces: `manageHeaders(csp?) -> HeadersInit`
- Produces: `oauthCallbackHtml() -> string`

- [x] **Step 1: 写鉴权、state 和回调页的失败测试**

在 `packages/worker/src/manage/security.test.ts` 使用 Node 内置测试：

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeManageRequest,
  createOAuthState,
  manageHeaders,
  oauthCallbackHtml,
  verifyOAuthState,
} from './security.ts'

test('management auth denies missing configuration and bad credentials', async () => {
  const request = new Request('https://worker.example/api/manage/compare')
  assert.equal((await authorizeManageRequest(request, undefined))?.status, 503)
  assert.equal((await authorizeManageRequest(request, 'secret'))?.status, 401)
  assert.equal((await authorizeManageRequest(
    new Request(request.url, { headers: { 'X-Manage-Secret': 'wrong' } }),
    'secret',
  ))?.status, 401)
  assert.equal(await authorizeManageRequest(
    new Request(request.url, { headers: { 'X-Manage-Secret': 'secret' } }),
    'secret',
  ), null)
})

test('management auth rejects a third-party browser origin', async () => {
  const response = await authorizeManageRequest(new Request(
    'https://worker.example/api/manage/compare',
    { headers: { Origin: 'https://evil.example', 'X-Manage-Secret': 'secret' } },
  ), 'secret')
  assert.equal(response?.status, 403)
  assert.equal(response?.headers.get('Access-Control-Allow-Origin'), null)
})

test('signed state validates and rejects tampering, expiry, and wrong purpose data', async () => {
  const now = Date.UTC(2026, 5, 19)
  const created = await createOAuthState('secret', 'account-a', now)
  assert.equal((await verifyOAuthState('secret', created.state, now))?.nonce, created.nonce)
  assert.equal(await verifyOAuthState('wrong-secret', created.state, now), null)
  assert.equal(await verifyOAuthState('secret', created.state + 'x', now), null)
  assert.equal(await verifyOAuthState('secret', created.state, now + 301_000), null)
  assert.equal(await verifyOAuthState('secret', 'x'.repeat(1025), now), null)
})

test('management headers disable storage and framing', () => {
  const headers = new Headers(manageHeaders())
  assert.equal(headers.get('Cache-Control'), 'no-store')
  assert.equal(headers.get('X-Frame-Options'), 'DENY')
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer')
})

test('callback posts only to the current origin', () => {
  const html = oauthCallbackHtml()
  assert.match(html, /location\.origin/)
  assert.doesNotMatch(html, /postMessage\([^)]*,\s*["']\*["']/)
})
```

- [x] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
```

Expected: FAIL，错误包含 `Cannot find module .../manage/security.ts`。

- [x] **Step 3: 实现最小安全模块**

在 `packages/worker/src/manage/security.ts` 实现以下结构，使用 `crypto.subtle`、`crypto.getRandomValues`、`TextEncoder`、`btoa` 和 `atob`，不引入库：

```ts
export type OAuthPurpose = 'account-a' | 'account-b' | 'cron'

export interface OAuthStatePayload {
  v: 1
  nonce: string
  purpose: OAuthPurpose
  exp: number
}

const STATE_TTL_SECONDS = 300
const STATE_MAX_LENGTH = 1024
const encoder = new TextEncoder()
const purposes = new Set<OAuthPurpose>(['account-a', 'account-b', 'cron'])

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function unbase64url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0))
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

function fixedEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false
  let difference = 0
  for (let i = 0; i < 32; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

async function stateKey(secret: string): Promise<CryptoKey> {
  const material = await digest(`bangumi-tv:oauth-state:v1\0${secret}`)
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

async function signState(secret: string, payload: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await stateKey(secret), encoder.encode(payload)))
}

export async function createOAuthState(
  secret: string,
  purpose: OAuthPurpose,
  now = Date.now(),
): Promise<{ state: string; nonce: string }> {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)))
  const payload: OAuthStatePayload = {
    v: 1,
    nonce,
    purpose,
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  }
  const encoded = base64url(encoder.encode(JSON.stringify(payload)))
  return { state: `${encoded}.${base64url(await signState(secret, encoded))}`, nonce }
}
```

`verifyOAuthState` 必须捕获所有解码/解析错误，要求恰好两个分段、总长不超过 1024、签名固定长度匹配、`v === 1`、nonce 为 22 个 base64url 字符、purpose 在白名单内、`exp` 是整数且晚于当前秒；失败统一返回 `null`。

`authorizeManageRequest` 必须按 `503 -> Origin 403 -> secret 401 -> null` 顺序执行，错误体统一为：

```ts
function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: manageHeaders() })
}
```

`oauthCallbackHtml()` 返回固定 HTML：读取 query 中的 `code`/`state`，调用
`window.opener.postMessage({type:"bgm-oauth",code,state}, location.origin)`，随后关闭窗口；不得拼接请求数据。

- [x] **Step 4: 运行安全测试**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
```

Expected: 5 tests PASS，0 fail。

- [x] **Step 5: 勾选 OpenSpec 任务 1.1 和 2.1 并提交**

```bash
git add packages/worker/src/manage/security.ts packages/worker/src/manage/security.test.ts openspec/changes/secure-management-api/tasks.md
git commit -m "feat: add management security primitives"
```

### Task 2: 管理路由、CORS、响应头和健康接口

- [x] Task 2 complete: 管理路由、CORS、响应头和健康接口

**Files:**
- Modify: `packages/worker/src/index.ts:1-236`
- Modify: `packages/worker/src/manage/security.test.ts`
- Modify: `openspec/changes/secure-management-api/tasks.md`

**Interfaces:**
- Consumes: `authorizeManageRequest`, `manageHeaders`, `oauthCallbackHtml`
- Produces: 所有 `/api/manage/*` 路由共用的默认拒绝中间件
- Produces: 仅公开读取 API 使用的 `Access-Control-Allow-Origin: *`

- [x] **Step 1: 增加安全错误和公开披露的失败测试**

向 `security.test.ts` 增加：

```ts
import { publicError } from './security.ts'

test('public errors never echo upstream text', async () => {
  const response = publicError(502, 'BGM_UPSTREAM', new Error('access_token=secret upstream body'))
  const body = await response.text()
  assert.deepEqual(JSON.parse(body), {
    error: { code: 'BGM_UPSTREAM', message: 'Upstream request failed' },
  })
  assert.doesNotMatch(body, /secret|upstream body/)
})
```

`publicError` 的第三个参数只用于内部结构化日志分类，不进入响应。

- [x] **Step 2: 运行新增测试并确认导出不存在**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
```

Expected: FAIL，错误指出 `publicError` 未导出。

- [x] **Step 3: 实现固定错误映射并改造 Worker 路由**

在 `security.ts` 增加：

```ts
export function publicError(status: number, code: string, _error?: unknown): Response {
  const messages: Record<string, string> = {
    BGM_AUTH: 'Upstream authorization failed',
    BGM_TIMEOUT: 'Upstream request timed out',
    BGM_UPSTREAM: 'Upstream request failed',
    INVALID_REQUEST: 'Invalid request',
    INVALID_OAUTH_STATE: 'Invalid OAuth state',
  }
  return Response.json(
    { error: { code, message: messages[code] || 'Request failed' } },
    { status, headers: manageHeaders() },
  )
}
```

在 `index.ts`：

1. 将全局 `app.use('*', cors(...))` 替换为仅绑定四个公开路径的 GET CORS：

```ts
const publicCors = cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] })
app.use('/api/collections', publicCors)
app.use('/api/calendar', publicCors)
app.use('/api/config', publicCors)
app.use('/api/health', publicCors)
```

2. 删除 `requireManageSecret` 和 `/api/manage/gate`。
3. 在全部管理 API 定义前添加统一中间件：

```ts
app.use('/api/manage/*', async (c, next) => {
  const denied = await authorizeManageRequest(c.req.raw, c.env.MANAGE_SECRET)
  if (denied) return denied
  await next()
  for (const [name, value] of Object.entries(manageHeaders())) c.header(name, String(value))
})
```

4. `/manage` 使用管理页 CSP；`/manage/callback` 使用 `oauthCallbackHtml()` 和更窄的 callback CSP。两者设置 `manageHeaders(...)`。
5. `errorToResponse` 不再返回 `err.message`；只映射固定 code/status，并调用：

```ts
console.error(JSON.stringify({
  event: 'manage_request_failed',
  route,
  kind: err instanceof Error ? err.name : 'Unknown',
  upstream_status: err instanceof BgmHttpError ? err.status : undefined,
  at: new Date().toISOString(),
}))
```

日志对象不得包含 message、request headers/body、code、state 或 token。
6. `/api/health` 不读取 `sync:last_error`，不返回 `users`、`last_error` 或异常文本；失败时记录 `{event:'health_failed',kind,at}` 并返回 `{ok:false}`。

- [x] **Step 4: 运行测试和 Wrangler dry-run**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
rm -rf /tmp/bangumitv-secure-management
WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-wrangler.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management --config packages/worker/wrangler.toml
```

Expected: Node tests PASS；Wrangler 输出 `Total Upload` 且退出码 0。

- [x] **Step 5: 检查管理路由没有全局通配 CORS 或公开 gate**

Run:

```bash
rg -n "origin: '\\*'|/api/manage/gate|requireManageSecret|users:|last_error:" packages/worker/src/index.ts
```

Expected: 只允许公开 CORS 配置中出现 `origin: '*'`；其余模式无匹配。

- [x] **Step 6: 勾选任务 1.2、1.3 并提交**

```bash
git add packages/worker/src/index.ts packages/worker/src/manage/security.ts packages/worker/src/manage/security.test.ts openspec/changes/secure-management-api/tasks.md
git commit -m "feat: isolate management API security boundary"
```

### Task 3: 受保护 OAuth POST 与 token 去向

- [x] Task 3 complete: 受保护 OAuth POST 与 token 去向

**Files:**
- Modify: `packages/worker/src/index.ts:138-193`
- Modify: `packages/worker/src/manage/oauth.ts`
- Modify: `packages/worker/src/manage/security.test.ts`
- Modify: `openspec/changes/secure-management-api/tasks.md`

**Interfaces:**
- Consumes: `OAuthPurpose`, `createOAuthState`, `verifyOAuthState`
- Produces: `POST /api/manage/oauth-url` body `{ purpose }`
- Produces: `POST /api/manage/exchange` body `{ code, state }`
- Produces: account response `{ access_token, user_id }` or cron response `{ ok: true }`

- [x] **Step 1: 增加用途和 nonce 边界测试**

向 `security.test.ts` 增加：

```ts
test('state carries only the requested purpose and nonce', async () => {
  const now = Date.UTC(2026, 5, 19)
  const created = await createOAuthState('secret', 'cron', now)
  const payload = await verifyOAuthState('secret', created.state, now)
  assert.deepEqual(payload, {
    v: 1,
    nonce: created.nonce,
    purpose: 'cron',
    exp: Math.floor(now / 1000) + 300,
  })
})

test('state rejects unsupported purpose and malformed nonce', async () => {
  const created = await createOAuthState('secret', 'account-b')
  const [payload, signature] = created.state.split('.')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString())
  decoded.purpose = 'admin'
  const changed = Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + signature
  assert.equal(await verifyOAuthState('secret', changed), null)
})
```

- [x] **Step 2: 运行测试并确认失败场景有效**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
```

Expected: 新测试在 state payload 校验未完整时 FAIL；实现完整后 PASS。

- [x] **Step 3: 将 OAuth 路由改为受保护 POST**

在 `index.ts`：

```ts
app.post('/api/manage/oauth-url', async (c) => {
  const body = await c.req.json<{ purpose?: OAuthPurpose }>().catch(() => ({}))
  if (!body.purpose || !['account-a', 'account-b', 'cron'].includes(body.purpose)) {
    return publicError(400, 'INVALID_REQUEST')
  }
  if (!c.env.BANGUMI_CLIENT_ID) return publicError(503, 'OAUTH_NOT_CONFIGURED')
  const created = await createOAuthState(c.env.MANAGE_SECRET!, body.purpose)
  const redirectUri = `${new URL(c.req.url).origin}/manage/callback`
  return Response.json({
    url: getOAuthRedirectUrl(c.env.BANGUMI_CLIENT_ID, redirectUri, created.state),
    state: created.state,
    nonce: created.nonce,
  })
})
```

`publicError` 的固定消息表补充 `OAUTH_NOT_CONFIGURED: 'OAuth is not configured'`。

将 exchange 改为：

```ts
app.post('/api/manage/exchange', async (c) => {
  const body = await c.req.json<{ code?: string; state?: string }>().catch(() => ({}))
  if (!body.code || !body.state) return publicError(400, 'INVALID_REQUEST')
  const state = await verifyOAuthState(c.env.MANAGE_SECRET!, body.state)
  if (!state) return publicError(400, 'INVALID_OAUTH_STATE')

  try {
    const result = await exchangeCode(
      c.env.BANGUMI_CLIENT_ID || '',
      c.env.BANGUMI_CLIENT_SECRET || '',
      body.code,
      `${new URL(c.req.url).origin}/manage/callback`,
    )
    if (state.purpose === 'cron') {
      await new KVStorage(c.env.BANGUMI_KV).put('bgm:tokens', {
        access_token: result.access_token,
        refresh_token: result.refresh_token,
      })
      return Response.json({ ok: true })
    }
    return Response.json({ access_token: result.access_token, user_id: result.user_id })
  } catch (err) {
    return errorToResponse(err, '/api/manage/exchange')
  }
})
```

校验 OAuth client id/secret 都存在后才调用上游。删除 GET query 中的 `code`、`cron` 和客户端自选固定 state。`oauth.ts` 的 `exchangeCode` 继续返回上游完整 token 对，但只有该路由局部可见 refresh token。

- [x] **Step 4: 运行测试、dry-run 和敏感响应扫描**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts
rm -rf /tmp/bangumitv-secure-management
WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-wrangler.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management --config packages/worker/wrangler.toml
rg -n "app\\.get\\('/api/manage/(oauth-url|exchange)|query\\('code'\\)|query\\('cron'\\)|return Response\\.json\\(result\\)" packages/worker/src/index.ts
```

Expected: tests 和 dry-run PASS；最后的 `rg` 无匹配。

- [x] **Step 5: 勾选任务 2.2 并提交**

```bash
git add packages/worker/src/index.ts packages/worker/src/manage/oauth.ts packages/worker/src/manage/security.test.ts openspec/changes/secure-management-api/tasks.md
git commit -m "feat: secure OAuth exchange and token handling"
```

### Task 4: 管理页内存状态、窗口关联和文本渲染

- [x] Task 4 complete: 管理页内存状态、窗口关联和文本渲染

**Files:**
- Modify: `packages/worker/src/manage/index.html`
- Create: `packages/worker/src/manage/index-html.test.mjs`
- Modify: `openspec/changes/secure-management-api/tasks.md`

**Interfaces:**
- Consumes: OAuth URL response `{ url, state, nonce }`
- Consumes: exchange responses `{ access_token, user_id }` or `{ ok: true }`
- Produces: 页面内存 `pendingOAuth = { purpose, state, nonce, popup } | null`

- [x] **Step 1: 写管理 HTML 的失败回归测试**

创建 `packages/worker/src/manage/index-html.test.mjs`：

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')

test('management credentials are memory-only', () => {
  assert.doesNotMatch(html, /sessionStorage|localStorage/)
  assert.match(html, /let manageSecret = ''/)
})

test('OAuth messages are bound to origin, popup, and state', () => {
  assert.match(html, /ev\.origin !== location\.origin/)
  assert.match(html, /ev\.source !== pendingOAuth\.popup/)
  assert.match(html, /d\.state !== pendingOAuth\.state/)
})

test('OAuth API calls use JSON POST', () => {
  assert.match(html, /\/api\/manage\/oauth-url/)
  assert.match(html, /\/api\/manage\/exchange/)
  assert.match(html, /method:\s*'POST'/)
  assert.doesNotMatch(html, /\/api\/manage\/exchange\?/)
})

test('untrusted values are not assigned through innerHTML', () => {
  assert.doesNotMatch(html, /\.innerHTML\s*=/)
  assert.match(html, /textContent/)
  assert.match(html, /createElement/)
})
```

- [x] **Step 2: 运行测试并确认现有持久化和 innerHTML 导致失败**

Run:

```bash
node --test packages/worker/src/manage/index-html.test.mjs
```

Expected: 4 tests FAIL，报告包含 `sessionStorage`、缺少 popup/origin/state 检查、GET exchange 或 `innerHTML`。

- [x] **Step 3: 改为只保留页面内存并显式绑定 OAuth 请求**

在管理页脚本顶部使用：

```js
let state = { userA: '', userB: '', tokenA: '', tokenB: '', differences: [] }
let manageSecret = ''
let pendingOAuth = null
```

删除 `probeGate()`、`/api/manage/gate`、`prompt()` 和全部 Web Storage 调用。页面初始只显示密码 panel；`submitGate()` 将输入写入 `manageSecret` 并显示管理内容。`apiFetch` 在 401/503 时重新显示 gate，且不自动持久化或重试：

```js
async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {})
  if (manageSecret) headers.set('X-Manage-Secret', manageSecret)
  const response = await fetch(url, { ...options, headers })
  if (response.status === 401 || response.status === 503) {
    document.getElementById('gate').style.display = 'block'
  }
  return response
}
```

发起授权统一使用：

```js
async function beginOAuth(purpose) {
  const response = await apiFetch('/api/manage/oauth-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  })
  const data = await response.json()
  if (!response.ok) return showError(targetFor(purpose), data, 'OAuth URL 获取失败')
  const popup = window.open(data.url, 'bgm-oauth')
  pendingOAuth = { purpose, state: data.state, nonce: data.nonce, popup }
}
```

消息处理必须先执行：

```js
window.addEventListener('message', async (ev) => {
  const d = ev.data
  if (!pendingOAuth || ev.origin !== location.origin) return
  if (ev.source !== pendingOAuth.popup) return
  if (!d || d.type !== 'bgm-oauth' || !d.code || d.state !== pendingOAuth.state) return
  await exchangeOAuth(d.code, d.state, pendingOAuth.purpose)
})
```

手工粘贴回调 URL 必须检查 `url.origin === location.origin` 且
`url.searchParams.get('state') === pendingOAuth.state`，再调用同一个 `exchangeOAuth`。

- [x] **Step 4: 将动态结果全部改为 DOM 文本构造**

提供三个小 helper，不建立组件框架：

```js
function clear(node) { node.replaceChildren() }

function textElement(tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = String(text ?? '')
  if (className) node.className = className
  return node
}

function showError(target, data, fallback) {
  clear(target)
  const box = document.createElement('div')
  box.className = 'error-box'
  box.append(textElement('strong', data?.error?.code || 'ERROR'))
  box.append(textElement('p', data?.error?.message || fallback || '请求失败'))
  target.append(box)
}
```

用 `replaceChildren`、`append`、`textContent` 和 `addEventListener` 重写：

- OAuth 手工输入控件；
- cron 成功/失败状态；
- A/B 授权状态；
- summary cards；
- 同步结果；
- partial difference list。

用户名、条目名、服务端错误和同步结果不得进入 HTML 字符串。固定页面骨架可继续保留静态 HTML。

exchange 请求统一为：

```js
const response = await apiFetch('/api/manage/exchange', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, state: signedState }),
})
```

cron 只以 `data.ok === true` 判断成功；A/B 只把 `data.access_token` 写入内存。每次交换完成后关闭 popup 并将 `pendingOAuth = null`。

- [x] **Step 5: 运行管理页回归测试和 Worker dry-run**

Run:

```bash
node --test packages/worker/src/manage/index-html.test.mjs
node --test packages/worker/src/manage/security.test.ts
rm -rf /tmp/bangumitv-secure-management
WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-wrangler.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management --config packages/worker/wrangler.toml
```

Expected: 9 个以上测试全部 PASS；Wrangler dry-run 退出码 0。

- [x] **Step 6: 勾选任务 2.3、2.4、3.1 并提交**

```bash
git add packages/worker/src/manage/index.html packages/worker/src/manage/index-html.test.mjs openspec/changes/secure-management-api/tasks.md
git commit -m "feat: harden management OAuth UI"
```

### Task 5: 部署文档与完整验证

- [x] Task 5 complete: 部署文档与完整验证

**Files:**
- Modify: `README.md`
- Modify: `openspec/changes/secure-management-api/tasks.md`

**Interfaces:**
- Consumes: 已实现的管理鉴权和 OAuth 流程
- Produces: 明确的部署前置条件、迁移和回滚说明

- [x] **Step 1: 更新 README 的强制配置和行为说明**

做以下精确修改：

- 阶段一 secrets 表中将 `MANAGE_SECRET` 改为“必填；管理 API 的共享密码，未配置时管理 API 返回 503”。
- 管理页面章节说明密码只保存在当前页面内存，刷新后需重输。
- cron OAuth 说明浏览器只看到成功状态，access/refresh token 由 Worker 直接写入 `bgm:tokens`。
- 删除“未配置则放行”“推荐配置”“可选的管理密码”等旧描述。
- 本地 `.dev.vars` 示例保留 `MANAGE_SECRET=本地管理密码`，不再标记可选。
- 环境变量表将 `MANAGE_SECRET` 标为必填 secret。
- 增加迁移顺序：先配置 secret，再部署，再验证 cron OAuth；回滚代码时不得删除 `bgm:tokens`，并继续保留 secret。

- [x] **Step 2: 扫描旧的不安全文案**

Run:

```bash
rg -n "MANAGE_SECRET.*可选|未配置则放行|管理页密码保护（推荐）|强烈建议配置" README.md
```

Expected: 无匹配。

- [x] **Step 3: 运行全部本地检查**

Run:

```bash
node --test packages/worker/src/manage/security.test.ts packages/worker/src/manage/index-html.test.mjs
OPENSPEC_TELEMETRY=0 node_modules/.bin/openspec validate secure-management-api --strict
rm -rf /tmp/bangumitv-secure-management
WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-wrangler.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management --config packages/worker/wrangler.toml
git diff --check
```

Expected:

- Node tests 全部 PASS；
- OpenSpec 输出 `Change 'secure-management-api' is valid`；
- Wrangler dry-run 输出 `Total Upload` 并退出 0；
- `git diff --check` 无输出。

- [x] **Step 4: 执行敏感信息与不安全模式扫描**

Run:

```bash
rg -n "sessionStorage|bgm-manage-secret|postMessage\\([^)]*,\\s*[\"']\\*[\"']|/api/manage/exchange\\?|/api/manage/gate|last_error:|users:" packages/worker/src README.md
rg -n "\\.innerHTML\\s*=" packages/worker/src/manage/index.html
```

Expected: 两条命令均无匹配。

- [x] **Step 5: 勾选任务 3.2，确认所有 OpenSpec 任务完成并提交**

Run:

```bash
grep -n '\\- \\[ \\]' openspec/changes/secure-management-api/tasks.md
```

Expected: 无输出。

Commit:

```bash
git add README.md openspec/changes/secure-management-api/tasks.md
git commit -m "docs: document secure management deployment"
```

- [x] **Step 6: 记录最终验证证据**

Run:

```bash
git status --short
git log --oneline --max-count=5
```

Expected: 当前 change 的实现文件无未提交修改；原先不属于本 change 的工具/OpenSpec 初始化脏文件保持原状且未被覆盖。

## Self-Review Result

- Spec coverage: 默认拒绝由 Tasks 1-2 覆盖；CORS、响应头、健康披露由 Task 2 覆盖；签名 state 和 token 去向由 Tasks 1、3 覆盖；popup 关联和文本渲染由 Task 4 覆盖；部署迁移由 Task 5 覆盖。
- Dependency check: 只使用 Web Crypto、Node 内置测试和现有 Wrangler/Hono。
- Type consistency: `OAuthPurpose`、`OAuthStatePayload`、`createOAuthState`、`verifyOAuthState`、`authorizeManageRequest` 在所有任务中名称一致。
- Scope check: 不修改 package/lock、同步一致性、前端部署简化或质量门禁 change。
