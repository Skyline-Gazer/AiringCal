# BangumiTV Cloudflare 迁移实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 BangumiTV 从 Vercel + 静态 JSON 架构迁移到 Cloudflare Workers + Pages + KV + R2，数据源改为 bgm.tv API。

**Architecture:** 单个 Worker（Hono 路由）处理 API、图片代理、Cron 同步。KV 缓存收藏数据，R2 缓存图片（content-hash 去重）。Pages 部署静态前端 widget。GitHub Actions CI/CD 自动创建 CF 资源并部署。

**Tech Stack:** TypeScript, Hono (router), Cloudflare Workers, KV, R2, esbuild

---

### Task 1: 更新 package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 更新依赖和 scripts**

用以下内容替换 `package.json`：

```json
{
  "name": "bangumi-tv",
  "version": "2.0.0",
  "description": "render your bangumi.tv progress on a static web page",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "build": "node build.js"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/markd3ng/BangumiTV.git"
  },
  "keywords": ["bangumi", "anime"],
  "author": "markd3ng",
  "license": "MIT",
  "devDependencies": {
    "hono": "^4.x",
    "wrangler": "^4.x",
    "esbuild": "^0.28.1",
    "dotenv": "^17.4.2",
    "axios": "^1.18.0"
  },
  "files": ["dist", "LICENSE", "README.md"]
}
```

- [ ] **Step 2: 安装新依赖**

```bash
pnpm install
```

- [ ] **Step 3: 提交**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: update dependencies for Cloudflare migration"
```

---

### Task 2: 创建 StorageAdapter 接口和 KV 实现

**Files:**
- Create: `src/storage/adapter.ts`
- Create: `src/storage/kv.ts`

- [ ] **Step 1: 写 StorageAdapter 接口**

`src/storage/adapter.ts`：

```ts
export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}
```

- [ ] **Step 2: 写 Cloudflare KV 实现**

`src/storage/kv.ts`：

```ts
import type { StorageAdapter } from './adapter'

export class KVStorage implements StorageAdapter {
  constructor(private kv: KVNamespace) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.kv.get(key, 'json')
    return raw as T | null
  }

  async put<T>(key: string, value: T): Promise<void> {
    await this.kv.put(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key)
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/storage/adapter.ts src/storage/kv.ts
git commit -m "feat: add StorageAdapter interface and KV implementation"
```

---

### Task 3: 创建 bgm.tv API 客户端

**Files:**
- Create: `src/sync/bgm-client.ts`

- [ ] **Step 1: 写 bgm-client.ts**

```ts
const BGM_BASE = 'https://api.bgm.tv'
const UA = 'markd3ng/BangumiTV (https://github.com/markd3ng/BangumiTV)'

export interface BgmCollection {
  subject_id: number
  subject_type: number
  rate: number
  type: number
  comment: string
  tags: string[]
  ep_status: number
  vol_status: number
  updated_at: string
  private: boolean
  subject?: BgmSlimSubject
}

export interface BgmSlimSubject {
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  nsfw: boolean
  date: string
  eps: number
  total_episodes: number
  images: { large: string; common: string; medium: string; small: string; grid: string }
  rating: { score: number; rank: number; total: number }
}

export interface BgmCalendarItem {
  weekday: { en: string; cn: string; ja: string; id: number }
  items: BgmSlimSubject[]
}

export class BgmClient {
  constructor(private token?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': UA }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  async getCollections(username: string, offset = 0, limit = 50): Promise<{ data: BgmCollection[]; total: number }> {
    const url = `${BGM_BASE}/v0/users/${username}/collections?subject_type=2&limit=${limit}&offset=${offset}`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) throw new Error(`bgm.tv collections error: ${res.status}`)
    return res.json()
  }

  async getSubject(subjectId: number): Promise<BgmSlimSubject | null> {
    const url = `${BGM_BASE}/v0/subjects/${subjectId}`
    const res = await fetch(url, { headers: this.headers() })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`bgm.tv subject error: ${res.status}`)
    return res.json()
  }

  async getCalendar(): Promise<BgmCalendarItem[]> {
    const url = `${BGM_BASE}/calendar`
    const res = await fetch(url, { headers: this.headers() })
    if (!res.ok) throw new Error(`bgm.tv calendar error: ${res.status}`)
    return res.json()
  }

  async downloadImage(url: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return null
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || 'image/jpeg',
    }
  }

  async oauthAccessToken(clientId: string, clientSecret: string, code: string, redirectUri: string) {
    const res = await fetch(`${BGM_BASE.replace('api.', '')}/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) throw new Error(`oauth error: ${res.status}`)
    return res.json() as Promise<{ access_token: string; refresh_token: string; user_id: number }>
  }

  async patchCollection(token: string, subjectId: number, body: Record<string, unknown>) {
    const url = `${BGM_BASE}/v0/users/-/collections/${subjectId}`
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`patch collection error: ${res.status}`)
    return res.json()
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/sync/bgm-client.ts
git commit -m "feat: add bgm.tv API client"
```

---

### Task 4: 创建收藏合并逻辑

**Files:**
- Create: `src/sync/merger.ts`

- [ ] **Step 1: 写 merger.ts**

```ts
import type { BgmCollection } from './bgm-client'

export interface MergedEntry {
  subject_id: number
  name: string
  name_cn: string
  summary: string
  images: { hash: string; w: number; h: number }
  eps: number
  total_episodes: number
  ep_status: number
  vol_status: number
  type: number
  collection_type: number
  rate: number
  nsfw: boolean
  date: string
  tags: string[]
}

export interface MergedCollections {
  want: MergedEntry[]
  watched: MergedEntry[]
  watching: MergedEntry[]
  on_hold: MergedEntry[]
  dropped: MergedEntry[]
  updated_at: string
}

const TYPE_MAP: Record<number, 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'> = {
  1: 'want',
  2: 'watched',
  3: 'watching',
  4: 'on_hold',
  5: 'dropped',
}

function toMergedEntry(c: BgmCollection): MergedEntry {
  const subj = c.subject
  return {
    subject_id: c.subject_id,
    name: subj?.name ?? '',
    name_cn: subj?.name_cn ?? '',
    summary: subj?.summary ?? '',
    images: { hash: '', w: 0, h: 0 },
    eps: subj?.eps ?? 0,
    total_episodes: subj?.total_episodes ?? 0,
    ep_status: c.ep_status,
    vol_status: c.vol_status,
    type: c.subject_type,
    collection_type: c.type,
    rate: c.rate,
    nsfw: subj?.nsfw ?? false,
    date: subj?.date ?? '',
    tags: c.tags ?? [],
  }
}

export function merge(usersCollections: BgmCollection[][]): MergedCollections {
  const map = new Map<number, MergedEntry>()

  for (const collections of usersCollections) {
    for (const c of collections) {
      const entry = toMergedEntry(c)
      const existing = map.get(c.subject_id)
      if (!existing || new Date(c.updated_at) > new Date(existing.date)) {
        map.set(c.subject_id, entry)
      }
    }
  }

  const result: MergedCollections = { want: [], watched: [], watching: [], on_hold: [], dropped: [], updated_at: new Date().toISOString() }
  for (const entry of map.values()) {
    const key = TYPE_MAP[entry.collection_type] ?? 'want'
    result[key].push(entry)
  }

  return result
}

export function primaryMerge(masterCollections: BgmCollection[]): MergedCollections {
  return merge([masterCollections])
}
```

- [ ] **Step 2: 提交**

```bash
git add src/sync/merger.ts
git commit -m "feat: add collection merge logic"
```

---

### Task 5: 创建 Cron 同步处理器

**Files:**
- Create: `src/sync/cron.ts`

- [ ] **Step 1: 写 cron.ts**

```ts
import { BgmClient } from './bgm-client'
import { merge, primaryMerge, type MergedCollections } from './merger'
import type { StorageAdapter } from '../storage/adapter'

async function fetchAllCollections(client: BgmClient, username: string): Promise<Awaited<ReturnType<typeof client.getCollections>>['data']> {
  const all: Awaited<ReturnType<typeof client.getCollections>>['data'] = []
  const first = await client.getCollections(username, 0, 1)
  const total = first.total
  if (total === 0) return []

  const limit = 50
  const totalPages = Math.ceil(total / limit)
  for (let page = 0; page < totalPages; page++) {
    const { data } = await client.getCollections(username, page * limit, limit)
    all.push(...data)
    if (page < totalPages - 1) await new Promise(r => setTimeout(r, 200))
  }
  return all
}

async function fetchSubjects(client: BgmClient, subjectIds: number[]) {
  const map = new Map<number, Awaited<ReturnType<typeof client.getSubject>>>()
  for (const id of subjectIds) {
    const subject = await client.getSubject(id)
    if (subject) map.set(id, subject)
    await new Promise(r => setTimeout(r, 100))
  }
  return map
}

export async function runSync(
  storage: StorageAdapter,
  token: string,
  users: string[],
  primaryUser: string | undefined,
  syncMode: string,
) {
  const client = new BgmClient(token)

  const allCollections = await Promise.all(
    users.map(u => fetchAllCollections(client, u))
  )

  let merged: MergedCollections
  if (syncMode === 'primary' && primaryUser) {
    const idx = users.indexOf(primaryUser)
    if (idx === -1) throw new Error(`Primary user ${primaryUser} not in users list`)
    merged = primaryMerge(allCollections[idx])
  } else {
    merged = merge(allCollections)
  }

  // 补充 subject 详情
  const allIds = new Set<number>()
  for (const key of ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const) {
    for (const e of merged[key]) allIds.add(e.subject_id)
  }
  const subjects = await fetchSubjects(client, [...allIds])
  for (const key of ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const) {
    for (const e of merged[key]) {
      const s = subjects.get(e.subject_id)
      if (s) {
        e.name = s.name
        e.name_cn = s.name_cn
        e.summary = s.summary
        e.nsfw = s.nsfw
        e.date = s.date
        e.eps = s.eps
        e.total_episodes = s.total_episodes
      }
    }
  }

  // 获取日历
  const calendar = await client.getCalendar()

  await storage.put('collections:merged', merged)
  await storage.put('calendar', calendar)

  return { merged, calendar }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/sync/cron.ts
git commit -m "feat: add cron sync handler"
```

---

### Task 6: 创建 API 路由处理器

**Files:**
- Create: `src/api/collections.ts`
- Create: `src/api/calendar.ts`
- Create: `src/api/config.ts`

- [ ] **Step 1: 写 collections.ts**

```ts
import type { StorageAdapter } from '../storage/adapter'
import type { MergedCollections } from '../sync/merger'

export async function handleCollections(storage: StorageAdapter, url: URL): Promise<Response> {
  const type = url.searchParams.get('type') || 'watching'
  const page = parseInt(url.searchParams.get('page') || '1')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '24'), 100)
  const nsfwShow = url.searchParams.get('nsfw') !== 'false'

  const merged = await storage.get<MergedCollections>('collections:merged')
  if (!merged) return Response.json({ data: [], total: 0, page: 1, types: {} })

  let list = (merged as Record<string, unknown[]>)[type] as unknown[] | undefined
  if (!list) list = []

  if (!nsfwShow) list = list.filter((e: Record<string, unknown>) => !e.nsfw)

  const total = list.length
  const start = (page - 1) * limit
  const data = list.slice(start, start + limit)

  const types = { want: 0, watched: 0, watching: 0, on_hold: 0, dropped: 0 }
  for (const key of Object.keys(types)) {
    types[key as keyof typeof types] = (merged[key as keyof MergedCollections] as unknown[]).length
  }

  return Response.json({ data, total, page, limit, types })
}
```

- [ ] **Step 2: 写 calendar.ts**

```ts
import type { StorageAdapter } from '../storage/adapter'

export async function handleCalendar(storage: StorageAdapter): Promise<Response> {
  const calendar = await storage.get('calendar')
  return Response.json(calendar || [])
}
```

- [ ] **Step 3: 写 config.ts**

```ts
export function handleConfig(url: URL, env: Record<string, string>): Response {
  const key = url.searchParams.get('key')
  if (key === 'nsfw') return Response.json({ nsfw: env.NSFW_SHOW === 'true' })
  return Response.json({ error: 'unknown key' }, { status: 400 })
}
```

- [ ] **Step 4: 提交**

```bash
git add src/api/collections.ts src/api/calendar.ts src/api/config.ts
git commit -m "feat: add API route handlers"
```

---

### Task 7: 创建 Worker 入口和 wrangler.toml

**Files:**
- Create: `workers/index.ts`
- Create: `wrangler.toml`

- [ ] **Step 1: 写 Worker 入口**

```ts
import { Hono } from 'hono'
import { KVStorage } from '../src/storage/kv'
import { handleCollections } from '../src/api/collections'
import { handleCalendar } from '../src/api/calendar'
import { handleConfig } from '../src/api/config'
import { runSync } from '../src/sync/cron'

interface Env {
  BANGUMI_KV: KVNamespace
  BANGUMI_R2: R2Bucket
  SYNC_MODE: string
  NSFW_SHOW: string
  BANGUMI_TOKEN: string
  BANGUMI_USERS: string
  BANGUMI_PRIMARY_USER?: string
  BANGUMI_CLIENT_ID?: string
  BANGUMI_CLIENT_SECRET?: string
  CRON_SECRET: string
}

const app = new Hono<{ Bindings: Env }>()

// CORS
app.use('*', async (c, next) => {
  c.res.headers.set('Access-Control-Allow-Origin', '*')
  c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204, headers: c.res.headers })
  await next()
})

// 公开 API
app.get('/api/collections', async (c) => {
  const storage = new KVStorage(c.env.BANGUMI_KV)
  return handleCollections(storage, new URL(c.req.url))
})

app.get('/api/calendar', async (c) => {
  const storage = new KVStorage(c.env.BANGUMI_KV)
  return handleCalendar(storage)
})

app.get('/api/config', (c) => {
  return handleConfig(new URL(c.req.url), { NSFW_SHOW: c.env.NSFW_SHOW })
})

// Cron 同步
app.post('/__cron/sync', async (c) => {
  const secret = c.req.header('X-Cron-Secret')
  if (secret !== c.env.CRON_SECRET) return new Response('Unauthorized', { status: 401 })

  const storage = new KVStorage(c.env.BANGUMI_KV)
  const users = c.env.BANGUMI_USERS.split(',').map(s => s.trim()).filter(Boolean)

  try {
    await runSync(storage, c.env.BANGUMI_TOKEN, users, c.env.BANGUMI_PRIMARY_USER, c.env.SYNC_MODE || 'merge')
    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('Sync error:', err)
    return new Response('Sync failed', { status: 500 })
  }
})

export default app
```

- [ ] **Step 2: 写 wrangler.toml**

```toml
name = "bangumi-tv"
main = "workers/index.ts"
compatibility_date = "2026-06-17"

[triggers]
crons = ["0 */4 * * *"]

[vars]
SYNC_MODE = "merge"
NSFW_SHOW = "true"

[[kv_namespaces]]
binding = "BANGUMI_KV"
id = "bangumi-tv-kv"

[[r2_buckets]]
binding = "BANGUMI_R2"
bucket_name = "bangumi-tv-images"
```

- [ ] **Step 3: 本地测试 Worker**

```bash
npx wrangler dev
```

确认 Worker 启动无报错。

- [ ] **Step 4: 提交**

```bash
git add workers/index.ts wrangler.toml
git commit -m "feat: add Worker entry point and wrangler config"
```

---

### Task 8: 创建 ImageStore 接口和 R2 实现

**Files:**
- Create: `src/image/store.ts`

- [ ] **Step 1: 写 ImageStore 接口和 R2 实现**

```ts
export interface ImageStore {
  getOriginal(hash: string): Promise<ArrayBuffer | null>
  putOriginal(hash: string, data: ArrayBuffer, contentType: string): Promise<void>
  getVariant(hash: string, variant: string): Promise<ArrayBuffer | null>
  putVariant(hash: string, variant: string, data: ArrayBuffer): Promise<void>
}

export class R2ImageStore implements ImageStore {
  constructor(private r2: R2Bucket) {}

  private key(hash: string, file: string): string {
    return `images/${hash}/${file}`
  }

  async getOriginal(hash: string): Promise<ArrayBuffer | null> {
    const obj = await this.r2.get(this.key(hash, 'original'))
    return obj ? obj.arrayBuffer() : null
  }

  async putOriginal(hash: string, data: ArrayBuffer, contentType: string): Promise<void> {
    await this.r2.put(this.key(hash, 'original'), data, {
      httpMetadata: { contentType },
    })
  }

  async getVariant(hash: string, variant: string): Promise<ArrayBuffer | null> {
    const obj = await this.r2.get(this.key(hash, variant))
    return obj ? obj.arrayBuffer() : null
  }

  async putVariant(hash: string, variant: string, data: ArrayBuffer): Promise<void> {
    await this.r2.put(this.key(hash, variant), data, {
      httpMetadata: { contentType: 'image/webp' },
    })
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/image/store.ts
git commit -m "feat: add ImageStore interface and R2 implementation"
```

---

### Task 9: 创建图片代理路由

**Files:**
- Create: `src/image/proxy.ts`

- [ ] **Step 1: 写 proxy.ts**

```ts
import { R2ImageStore, type ImageStore } from './store'
import { BgmClient } from '../sync/bgm-client'

const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=31536000, immutable' }

export async function handleImage(
  env: { BANGUMI_R2: R2Bucket; BANGUMI_TOKEN?: string },
  request: Request
): Promise<Response> {
  const url = new URL(request.url)

  // /image/:hash?w=300&fmt=webp
  const hash = url.pathname.split('/')[2]
  if (!hash || hash.length !== 64) {
    return new Response('Invalid hash', { status: 400 })
  }

  const width = parseInt(url.searchParams.get('w') || '300')
  const fmt = url.searchParams.get('fmt') || 'webp'
  const variant = `w${width}.${fmt}`
  const validWidths = [200, 300, 400, 600]
  const w = validWidths.includes(width) ? width : 300

  const store = new R2ImageStore(env.BANGUMI_R2)

  // 1. 查变体
  const variantData = await store.getVariant(hash, variant)
  if (variantData) {
    return new Response(variantData, { headers: { ...CACHE_HEADERS, 'Content-Type': `image/${fmt}` } })
  }

  // 2. 查原图
  let original = await store.getOriginal(hash)
  if (!original) {
    // 3. 从 bgm.tv 下载原图。此处简化：原图需要在 cron 同步时预热。
    // 如果没找到原图，返回占位图
    return new Response('Not found', { status: 404 })
  }

  // 4. 生成变体（简化版：直接返回原图，Cloudflare Image Resizing 在 wrangler.toml 中配置即可自动处理）
  // 如果不用 CF Image Resizing，则返回原图让浏览器缩放
  await store.putVariant(hash, variant, original)
  return new Response(original, { headers: { ...CACHE_HEADERS, 'Content-Type': 'image/jpeg' } })
}
```

- [ ] **Step 2: 把图片代理路由注册到 Worker**

修改 `workers/index.ts`，在 `app.get('/api/config', ...)` 后追加：

```ts
import { handleImage } from '../src/image/proxy'

app.get('/image/*', async (c) => {
  return handleImage({ BANGUMI_R2: c.env.BANGUMI_R2, BANGUMI_TOKEN: c.env.BANGUMI_TOKEN }, c.req.raw)
})
```

- [ ] **Step 3: 提交**

```bash
git add src/image/proxy.ts workers/index.ts
git commit -m "feat: add image proxy route"
```

---

### Task 10: 创建 OAuth 流程处理器

**Files:**
- Create: `src/manage/oauth.ts`

- [ ] **Step 1: 写 oauth.ts**

```ts
import { BgmClient } from '../sync/bgm-client'

export interface OAuthState {
  userA: string
  userB: string
  tokenA?: string
  tokenB?: string
  step: 'input' | 'authA' | 'authB' | 'ready'
}

export function generateState(userA: string, userB: string): string {
  return btoa(JSON.stringify({ userA, userB, step: 'authA' }))
}

export function parseState(state: string): OAuthState | null {
  try {
    return JSON.parse(atob(state))
  } catch {
    return null
  }
}

export function getOAuthRedirectUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    scope: '',
  })
  return `https://bgm.tv/oauth/authorize?${params.toString()}`
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; refresh_token: string; user_id: number }> {
  const client = new BgmClient()
  return client.oauthAccessToken(clientId, clientSecret, code, redirectUri)
}
```

- [ ] **Step 2: 提交**

```bash
git add src/manage/oauth.ts
git commit -m "feat: add OAuth flow helpers"
```

---

### Task 11: 创建账户对比逻辑

**Files:**
- Create: `src/manage/compare.ts`

- [ ] **Step 1: 写 compare.ts**

```ts
import { BgmClient, type BgmCollection } from '../sync/bgm-client'

export interface CompareResult {
  userA: { name: string; collections: BgmCollection[]; total: number }
  userB: { name: string; collections: BgmCollection[]; total: number }
  common: number
  differences: Difference[]
}

export interface Difference {
  subject_id: number
  name: string
  name_cn: string
  images: { large: string; common: string; medium: string; small: string; grid: string }
  typeA: number
  typeB: number
  epStatusA: number
  epStatusB: number
  volStatusA: number
  volStatusB: number
  rateA: number
  rateB: number
}

async function fetchAll(token: string, username: string): Promise<BgmCollection[]> {
  const client = new BgmClient(token)
  const all: BgmCollection[] = []
  const first = await client.getCollections(username, 0, 1)
  if (first.total === 0) return []

  const limit = 50
  const pages = Math.ceil(first.total / limit)
  for (let p = 0; p < pages; p++) {
    const { data } = await client.getCollections(username, p * limit, limit)
    all.push(...data)
    if (p < pages - 1) await new Promise(r => setTimeout(r, 200))
  }
  return all
}

export async function compareAccounts(
  tokenA: string,
  userA: string,
  tokenB: string,
  userB: string,
): Promise<CompareResult> {
  const [colA, colB] = await Promise.all([
    fetchAll(tokenA, userA),
    fetchAll(tokenB, userB),
  ])

  const mapA = new Map(colA.map(c => [c.subject_id, c]))
  const mapB = new Map(colB.map(c => [c.subject_id, c]))

  const differences: Difference[] = []
  const allIds = new Set([...mapA.keys(), ...mapB.keys()])

  for (const id of allIds) {
    const a = mapA.get(id)
    const b = mapB.get(id)
    if (!a || !b) continue

    if (a.type !== b.type || a.ep_status !== b.ep_status || a.vol_status !== b.vol_status || a.rate !== b.rate) {
      differences.push({
        subject_id: id,
        name: a.subject?.name ?? b.subject?.name ?? '',
        name_cn: a.subject?.name_cn ?? b.subject?.name_cn ?? '',
        images: a.subject?.images ?? b.subject?.images ?? { large: '', common: '', medium: '', small: '', grid: '' },
        typeA: a.type,
        typeB: b.type,
        epStatusA: a.ep_status,
        epStatusB: b.ep_status,
        volStatusA: a.vol_status,
        volStatusB: b.vol_status,
        rateA: a.rate,
        rateB: b.rate,
      })
    }
  }

  return {
    userA: { name: userA, collections: colA, total: colA.length },
    userB: { name: userB, collections: colB, total: colB.length },
    common: [...allIds].filter(id => mapA.has(id) && mapB.has(id)).length,
    differences,
  }
}
```

- [ ] **Step 2: 提交**

```bash
git add src/manage/compare.ts
git commit -m "feat: add account comparison logic"
```

---

### Task 12: 创建同步写回逻辑

**Files:**
- Create: `src/manage/sync-write.ts`

- [ ] **Step 1: 写 sync-write.ts**

```ts
import { BgmClient, type BgmCollection } from '../sync/bgm-client'

export interface SyncRequest {
  mode: 'full' | 'partial'
  from: string
  to: string
  subject_ids?: number[]
}

export interface SyncResult {
  subject_id: number
  name: string
  status: 'ok' | 'error'
  error?: string
}

async function fetchAllWithToken(token: string, username: string): Promise<BgmCollection[]> {
  const client = new BgmClient(token)
  const all: BgmCollection[] = []
  const first = await client.getCollections(username, 0, 1)
  if (first.total === 0) return []

  const limit = 50
  const pages = Math.ceil(first.total / limit)
  for (let p = 0; p < pages; p++) {
    const { data } = await client.getCollections(username, p * limit, limit)
    all.push(...data)
    if (p < pages - 1) await new Promise(r => setTimeout(r, 200))
  }
  return all
}

export async function executeSync(
  fromToken: string,
  fromUser: string,
  toToken: string,
  toUser: string,
  request: SyncRequest,
): Promise<SyncResult[]> {
  const fromCol = await fetchAllWithToken(fromToken, fromUser)
  const fromMap = new Map(fromCol.map(c => [c.subject_id, c]))

  const toCol = await fetchAllWithToken(toToken, toUser)
  const toMap = new Map(toCol.map(c => [c.subject_id, c]))

  let targets: BgmCollection[]
  if (request.mode === 'full') {
    targets = fromCol
  } else {
    const ids = new Set(request.subject_ids || [])
    targets = fromCol.filter(c => ids.has(c.subject_id))
  }

  const client = new BgmClient()
  const results: SyncResult[] = []

  for (const entry of targets) {
    try {
      const body: Record<string, unknown> = {
        type: entry.type,
        rate: entry.rate,
        ep_status: entry.ep_status,
        vol_status: entry.vol_status,
        tags: entry.tags || [],
        comment: entry.comment || '',
      }
      await client.patchCollection(toToken, entry.subject_id, body)
      results.push({ subject_id: entry.subject_id, name: entry.subject?.name_cn || entry.subject?.name || String(entry.subject_id), status: 'ok' })
    } catch (err) {
      results.push({ subject_id: entry.subject_id, name: entry.subject?.name_cn || entry.subject?.name || String(entry.subject_id), status: 'error', error: String(err) })
    }
    await new Promise(r => setTimeout(r, 200))
  }

  return results
}
```

- [ ] **Step 2: 提交**

```bash
git add src/manage/sync-write.ts
git commit -m "feat: add sync write-back logic"
```

---

### Task 13: 创建管理页面 HTML

**Files:**
- Create: `manage/index.html`

- [ ] **Step 1: 写管理页面 HTML**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BangumiTV - 多账户同步</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: #e0e0e0; min-height: 100vh; display: flex; justify-content: center; padding: 40px 20px; }
    .container { max-width: 800px; width: 100%; }
    h1 { text-align: center; margin-bottom: 32px; color: #fff; }
    .step { background: #16213e; border-radius: 12px; padding: 24px; margin-bottom: 16px; display: none; }
    .step.active { display: block; }
    label { display: block; margin-bottom: 8px; color: #a0a0b0; }
    input[type="text"] { width: 100%; padding: 12px; border: 1px solid #2a2a4a; border-radius: 8px; background: #0f3460; color: #fff; font-size: 16px; margin-bottom: 16px; }
    input[type="text"]:focus { outline: none; border-color: #e94560; }
    button { padding: 12px 24px; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; background: #e94560; color: #fff; margin-right: 8px; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    button.secondary { background: #0f3460; }
    .diff-item { display: flex; align-items: center; gap: 12px; padding: 12px; border-bottom: 1px solid #2a2a4a; }
    .diff-item img { width: 60px; height: 85px; object-fit: cover; border-radius: 4px; }
    .diff-info { flex: 1; }
    .diff-info h3 { font-size: 14px; margin-bottom: 4px; }
    .diff-info p { font-size: 12px; color: #a0a0b0; }
    .progress { margin-top: 16px; }
    .progress-bar { height: 8px; background: #2a2a4a; border-radius: 4px; overflow: hidden; }
    .progress-fill { height: 100%; background: #e94560; transition: width 0.3s; }
    select { padding: 8px 12px; border-radius: 6px; background: #0f3460; color: #fff; border: 1px solid #2a2a4a; }
    .summary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .summary-card { background: #0f3460; border-radius: 8px; padding: 16px; text-align: center; }
    .summary-card .count { font-size: 28px; font-weight: bold; color: #e94560; }
    .summary-card .label { font-size: 12px; color: #a0a0b0; margin-top: 4px; }
  </style>
</head>
<body>
<div class="container">
  <h1>BangumiTV 多账户同步</h1>

  <!-- Step 1: 输入用户名 -->
  <div class="step active" id="step1">
    <h2>步骤 1: 输入 bgm.tv 用户名</h2>
    <label>账号 A</label>
    <input type="text" id="userA" placeholder="输入 bgm.tv 用户名">
    <label>账号 B</label>
    <input type="text" id="userB" placeholder="输入 bgm.tv 用户名">
    <button onclick="startOAuth()">下一步：OAuth 授权</button>
  </div>

  <!-- Step 2: OAuth 授权 -->
  <div class="step" id="step2">
    <h2>步骤 2: OAuth 授权</h2>
    <p id="oauth-status">等待授权...</p>
    <div id="oauth-buttons"></div>
  </div>

  <!-- Step 3: 选择同步模式 -->
  <div class="step" id="step3">
    <h2>步骤 3: 选择同步模式</h2>
    <div class="summary" id="step3-summary"></div>
    <div style="margin-bottom:20px">
      <label>同步方向</label>
      <select id="sync-direction">
        <option value="A->B">A → B</option>
        <option value="B->A">B → A</option>
      </select>
    </div>
    <button onclick="startFullSync()">完整同步（所有条目）</button>
    <button onclick="showPartialSync()">部分同步（选择条目）</button>
    <div id="partial-list" style="display:none; margin-top:16px;">
      <label><input type="checkbox" id="select-all" onchange="toggleAll(this)"> 全选</label>
      <div id="diff-list"></div>
      <button onclick="startPartialSync()">同步选中条目</button>
    </div>
  </div>

  <!-- Step 4: 执行 -->
  <div class="step" id="step4">
    <h2>步骤 4: 同步中...</h2>
    <div class="progress">
      <div class="progress-bar"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
      <p id="progress-text" style="margin-top:8px;">准备中...</p>
    </div>
    <div id="sync-results" style="margin-top:16px;"></div>
    <button onclick="location.reload()" style="margin-top:16px;">返回</button>
  </div>
</div>

<script>
let state = { userA: '', userB: '', tokenA: '', tokenB: '' }

function showStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'))
  document.getElementById('step'+n).classList.add('active')
}

async function startOAuth() {
  state.userA = document.getElementById('userA').value.trim()
  state.userB = document.getElementById('userB').value.trim()
  if (!state.userA || !state.userB) return alert('请输入两个用户名')
  showStep(2)
  document.getElementById('oauth-status').textContent = '正在为 ' + state.userA + ' 发起授权...'
  const res = await fetch('/api/manage/oauth-url?user=' + encodeURIComponent(state.userA) + '&state=A')
  const { url } = await res.json()
  window.open(url, '_blank')
  document.getElementById('oauth-status').textContent = '请在弹出窗口中完成 ' + state.userA + ' 的授权，然后将回调 URL 粘贴到下方：'
  document.getElementById('oauth-buttons').innerHTML = `
    <input type="text" id="callbackA" placeholder="粘贴回调 URL">
    <button onclick="submitCallback('A')">确认</button>
  `
}

async function submitCallback(which) {
  const url = document.getElementById('callback'+which).value.trim()
  const code = new URL(url).searchParams.get('code')
  if (!code) return alert('无效的回调 URL')
  const res = await fetch('/api/manage/exchange?code=' + encodeURIComponent(code) + '&user=' + encodeURIComponent(which === 'A' ? state.userA : state.userB))
  const data = await res.json()
  if (which === 'A') {
    state.tokenA = data.access_token
    document.getElementById('oauth-status').textContent = '正在为 ' + state.userB + ' 发起授权...'
    const res2 = await fetch('/api/manage/oauth-url?user=' + encodeURIComponent(state.userB) + '&state=B')
    const { url: urlB } = await res2.json()
    window.open(urlB, '_blank')
    document.getElementById('oauth-buttons').innerHTML = `
      <input type="text" id="callbackB" placeholder="粘贴回调 URL">
      <button onclick="submitCallback('B')">确认</button>
    `
  } else {
    state.tokenB = data.access_token
    loadComparison()
  }
}

async function loadComparison() {
  showStep(3)
  const res = await fetch('/api/manage/compare?tokenA=' + encodeURIComponent(state.tokenA) + '&tokenB=' + encodeURIComponent(state.tokenB) + '&userA=' + state.userA + '&userB=' + state.userB)
  const data = await res.json()
  document.getElementById('step3-summary').innerHTML = `
    <div class="summary-card"><div class="count">${data.userA.total}</div><div class="label">${state.userA}</div></div>
    <div class="summary-card"><div class="count">${data.userB.total}</div><div class="label">${state.userB}</div></div>
  `
  // 保存差异列表用于部分同步
  state.differences = data.differences
}

async function doSync(mode, subjectIds) {
  showStep(4)
  const res = await fetch('/api/manage/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode, from: state.userA, to: state.userB,
      tokenA: state.tokenA, tokenB: state.tokenB,
      subject_ids: subjectIds || []
    })
  })
  const results = await res.json()
  const ok = results.filter(r => r.status === 'ok').length
  document.getElementById('progress-fill').style.width = '100%'
  document.getElementById('progress-text').textContent = `完成: ${ok}/${results.length}`
  document.getElementById('sync-results').innerHTML = results.map(r =>
    `<div class="diff-item"><span>${r.status === 'ok' ? '✓' : '✗'}</span><span>${r.name}</span></div>`
  ).join('')
}

function startFullSync() { doSync('full', []) }
function startPartialSync() {
  const checks = document.querySelectorAll('#diff-list input:checked')
  const ids = [...checks].map(c => parseInt(c.value))
  if (ids.length === 0) return alert('请至少选择一个条目')
  doSync('partial', ids)
}
function showPartialSync() {
  document.getElementById('partial-list').style.display = 'block'
  document.getElementById('diff-list').innerHTML = (state.differences||[]).map(d => `
    <div class="diff-item">
      <input type="checkbox" value="${d.subject_id}">
      <div class="diff-info">
        <h3>${d.name_cn || d.name}</h3>
        <p>A: ${d.epStatusA}ep | B: ${d.epStatusB}ep</p>
      </div>
    </div>
  `).join('')
}
function toggleAll(el) {
  document.querySelectorAll('#diff-list input[type=checkbox]').forEach(c => c.checked = el.checked)
}
</script>
</body>
</html>
```

- [ ] **Step 2: 提交**

```bash
git add manage/index.html
git commit -m "feat: add manage page HTML"
```

---

### Task 14: 注册管理页面和 OAuth 路由到 Worker

**Files:**
- Modify: `workers/index.ts`

- [ ] **Step 1: 在 Worker 入口中追加管理页面路由**

在 `workers/index.ts` 中导入部分后面追加：

```ts
import { handleOAuthUrl } from '../src/manage/oauth'
import { compareAccounts } from '../src/manage/compare'
import { executeSync } from '../src/manage/sync-write'

// 管理页面 — HTML 由 esbuild 构建时内联为字符串导入
import manageHtml from '../manage/index.html' with { type: 'text' }

app.get('/manage', () => {
  return new Response(manageHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

app.get('/manage/callback', (c) => {
  const html = `<html><body><script>window.opener.postMessage({code: new URLSearchParams(window.location.search).get('code')}, '*');window.close();</script></body></html>`
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

app.get('/api/manage/compare', async (c) => {
  const url = new URL(c.req.url)
  const tokenA = url.searchParams.get('tokenA') || ''
  const tokenB = url.searchParams.get('tokenB') || ''
  const userA = url.searchParams.get('userA') || ''
  const userB = url.searchParams.get('userB') || ''
  try {
    const result = await compareAccounts(tokenA, userA, tokenB, userB)
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
})

app.post('/api/manage/sync', async (c) => {
  const body = await c.req.json()
  try {
    const results = await executeSync(body.tokenA, body.from, body.tokenB, body.to, {
      mode: body.mode,
      from: body.from,
      to: body.to,
      subject_ids: body.subject_ids,
    })
    return Response.json(results)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
})

app.get('/api/manage/oauth-url', (c) => {
  const user = c.req.query('user') || ''
  const state = c.req.query('state') || ''
  const clientId = c.env.BANGUMI_CLIENT_ID || ''
  const redirectUri = `${new URL(c.req.url).origin}/manage/callback`
  const url = `https://bgm.tv/oauth/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=`
  return Response.json({ url })
})

app.get('/api/manage/exchange', async (c) => {
  const code = c.req.query('code') || ''
  const { exchangeCode } = await import('../src/manage/oauth')
  try {
    const result = await exchangeCode(
      c.env.BANGUMI_CLIENT_ID || '',
      c.env.BANGUMI_CLIENT_SECRET || '',
      code,
      `${new URL(c.req.url).origin}/manage/callback`,
    )
    return Response.json(result)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
})
```

- [ ] **Step 2: 提交**

```bash
git add workers/index.ts
git commit -m "feat: register manage page and OAuth routes"
```

---

### Task 15: 更新前端 Widget

**Files:**
- Modify: `public/index.html`
- Modify: `public/src/bangumi.js`
- Modify: `public/src/bangumi.css`
- Create: `public/src/nsfw-modal.js`（实际内联到 bangumi.js）

- [ ] **Step 1: 更新 index.html**

用以下内容重写 `public/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="src/bangumi.css">
  <style>
    blockquote { border-left: .25em solid #dfe2e5; color: #6a737d; padding: 0 1em; margin-left: 0; }
  </style>
  <script>
    const bgmConfig = {
      apiUrl: "https://<YOUR_WORKER_DOMAIN>",
      quote: "生命不止，追番不息！"
    }
  </script>
  <title>BangumiTV</title>
</head>
<body>
  <div id="bgm-age-modal" style="display:none;">
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#16213e;padding:40px;border-radius:12px;text-align:center;max-width:400px;">
        <h2 style="color:#fff;">⚠️ 内容警告</h2>
        <p style="color:#a0a0b0;margin:20px 0;">本页面包含成人内容（R18），您是否已满18岁？</p>
        <button onclick="bgmConfirmAge()" style="padding:12px 32px;background:#e94560;border:none;border-radius:8px;color:#fff;cursor:pointer;margin:4px;">我已满18岁，进入</button>
        <button onclick="window.close()" style="padding:12px 32px;background:#0f3460;border:none;border-radius:8px;color:#fff;cursor:pointer;margin:4px;">离开</button>
      </div>
    </div>
  </div>
  <div class="bgm-container"></div>
  <script src="src/bangumi.js"></script>
</body>
</html>
```

- [ ] **Step 2: 更新 bangumi.js**

重写 `public/src/bangumi.js`，核心改动：API 路径变为 `/api/collections`，响应格式适配新 API：

```js
(function () {
  const config = window.bgmConfig || { apiUrl: '', quote: '' }
  const API = (config.apiUrl || '').replace(/\/$/, '')
  const container = document.querySelector('.bgm-container')
  if (!container || !API) return

  // 集合类型映射
  const TYPE_NAMES = { want: '想看', watched: '看过', watching: '在看', on_hold: '搁置', dropped: '抛弃' }

  // NSFW 检查
  async function checkNSFW() {
    try {
      const res = await fetch(API + '/api/config?key=nsfw')
      const data = await res.json()
      if (data.nsfw && !localStorage.getItem('bgm-age-confirmed')) {
        document.getElementById('bgm-age-modal').style.display = 'block'
      } else if (!data.nsfw) {
        localStorage.removeItem('bgm-age-confirmed')
      }
    } catch (e) {}
  }

  window.bgmConfirmAge = function () {
    localStorage.setItem('bgm-age-confirmed', '1')
    document.getElementById('bgm-age-modal').style.display = 'none'
  }

  // 渲染条目卡片
  function renderCard(entry) {
    const imgUrl = entry.images?.hash
      ? `${API}/image/${entry.images.hash}?w=300&fmt=webp`
      : 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" fill="%23333"><rect width="300" height="400"/></svg>'

    const progress = entry.total_episodes > 0
      ? Math.round((entry.ep_status / entry.total_episodes) * 100)
      : 0

    return `
      <a href="https://bgm.tv/subject/${entry.subject_id}" target="_blank" class="bgm-card${entry.nsfw ? ' bgm-nsfw' : ''}">
        <div class="bgm-card-cover">
          <img src="${imgUrl}" alt="${entry.name_cn || entry.name}" loading="lazy">
          ${entry.nsfw ? '<div class="bgm-nsfw-overlay" onclick="event.preventDefault();this.parentElement.parentElement.classList.toggle(\'bgm-nsfw-reveal\')">R18</div>' : ''}
        </div>
        <div class="bgm-card-info">
          <h3>${entry.name_cn || entry.name}</h3>
          ${progress > 0 ? `<div class="bgm-progress"><span style="width:${progress}%"></span></div>` : ''}
          <span class="bgm-ep">${entry.ep_status}/${entry.total_episodes || '??'}</span>
        </div>
      </a>`
  }

  // 渲染全部收藏
  async function render() {
    const nav = document.createElement('div')
    nav.className = 'bgm-nav'
    nav.innerHTML = Object.entries(TYPE_NAMES).map(([k, v]) =>
      `<button data-type="${k}">${v}</button>`
    ).join('')
    container.appendChild(nav)

    const grid = document.createElement('div')
    grid.className = 'bgm-grid'
    container.appendChild(grid)

    const pagination = document.createElement('div')
    pagination.className = 'bgm-pagination'
    container.appendChild(pagination)

    let currentType = 'watching'
    let currentPage = 1

    async function load(type, page) {
      try {
        const res = await fetch(`${API}/api/collections?type=${type}&page=${page}&limit=24`)
        const data = await res.json()
        grid.innerHTML = data.data.map(renderCard).join('')

        // 分页
        const totalPages = Math.ceil(data.total / 24)
        pagination.innerHTML = ''
        for (let i = 1; i <= totalPages; i++) {
          const btn = document.createElement('button')
          btn.textContent = i
          if (i === page) btn.classList.add('active')
          btn.onclick = () => { currentPage = i; load(currentType, i) }
          pagination.appendChild(btn)
        }
      } catch (e) {
        grid.innerHTML = '<p style="color:#a0a0b0;">加载失败</p>'
      }
    }

    nav.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') {
        currentType = e.target.dataset.type
        currentPage = 1
        load(currentType, 1)
      }
    })

    await checkNSFW()
    load(currentType, 1)
  }

  render()
})()
```

- [ ] **Step 3: 更新 bangumi.css**

在现有 `public/src/bangumi.css` 末尾追加 NSFW 样式：

```css
/* NSFW 模糊遮罩 */
.bgm-card.bgm-nsfw .bgm-card-cover {
  position: relative;
  overflow: hidden;
}
.bgm-card.bgm-nsfw .bgm-card-cover img {
  filter: blur(20px);
  transition: filter 0.3s;
}
.bgm-card.bgm-nsfw.bgm-nsfw-reveal .bgm-card-cover img {
  filter: blur(0);
}
.bgm-nsfw-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,0.5);
  color: #e94560;
  font-size: 18px;
  font-weight: bold;
  cursor: pointer;
  z-index: 2;
}
.bgm-nsfw-reveal .bgm-nsfw-overlay {
  display: none;
}
```

- [ ] **Step 4: 删除 nsfw-modal.js**

NFWS 弹窗已内联在 index.html 和 bangumi.js 中，无需单独文件。

```bash
rm -f public/src/nsfw-modal.js
```

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/src/bangumi.js public/src/bangumi.css
git rm public/src/nsfw-modal.js 2>/dev/null || true
git commit -m "feat: update frontend widget for new API and NSFW support"
```

---

### Task 16: 删除旧文件

**Files:**
- Delete: `app.js`, `collection.js`, `api/serverless.js`, `data/*.json`, `vercel.json`

- [ ] **Step 1: 删除旧文件**

```bash
rm -f app.js collection.js api/serverless.js data/*.json vercel.json
```

确认删除后：

```bash
git add -u
git commit -m "chore: remove old Vercel serverless files"
```

---

### Task 17: 创建 GitHub Actions 部署工作流

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: 写 deploy.yml**

```yaml
name: Deploy to Cloudflare

on:
  push:
    branches: [dev]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: latest

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install

      - name: Provision Cloudflare resources
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: |
            kv namespace create "bangumi-tv-kv" 2>/dev/null || echo "KV exists"
            r2 bucket create "bangumi-tv-images" 2>/dev/null || echo "R2 bucket exists"

      - name: Get KV namespace ID
        id: kv-id
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: kv namespace list --json | jq -r '.[] | select(.title == "bangumi-tv-kv") | .id'

      - name: Inject KV id into wrangler.toml
        run: |
          KV_ID="${{ steps.kv-id.outputs.stdout }}"
          sed -i "s/id = \"bangumi-tv-kv\"/id = \"${KV_ID}\"/" wrangler.toml

      - name: Build frontend
        run: node build.js

      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: deploy
          secrets: |
            BANGUMI_TOKEN
            BANGUMI_REFRESH_TOKEN
            BANGUMI_CLIENT_ID
            BANGUMI_CLIENT_SECRET
            CRON_SECRET
        env:
          BANGUMI_TOKEN: ${{ secrets.BANGUMI_TOKEN }}
          BANGUMI_REFRESH_TOKEN: ${{ secrets.BANGUMI_REFRESH_TOKEN }}
          BANGUMI_CLIENT_ID: ${{ secrets.BANGUMI_CLIENT_ID }}
          BANGUMI_CLIENT_SECRET: ${{ secrets.BANGUMI_CLIENT_SECRET }}
          CRON_SECRET: ${{ secrets.CRON_SECRET }}

      - name: Deploy Pages
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          command: pages deploy public/ --project-name=bangumi-tv
```

- [ ] **Step 2: 提交**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: add GitHub Actions deploy workflow"
```

---

### Task 18: 重写 README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 写 README.md**

```markdown
# BangumiTV

> 在静态页面中渲染你的 Bangumi 追番进度

基于 Cloudflare Workers + Pages，数据直接来源于 bgm.tv API，条目图片通过 R2 缓存分发。

## Demo

https://bangumi-tv.<YOUR_WORKER>.workers.dev

## 前置条件

- [Cloudflare](https://cloudflare.com) 账号
- [bgm.tv](https://bgm.tv) 账号及 [OAuth App](https://bgm.tv/dev/app)（用于管理页面的多账户同步）
- GitHub 账号

## 快速部署

1. **Fork 本仓库**

2. **配置 GitHub Secrets & Variables**

   前往 Repo → Settings → Secrets and variables → Actions，添加：

   **Secrets:**
   | 名称 | 说明 |
   |------|------|
   | `CF_API_TOKEN` | Cloudflare API Token（需 Workers/R2/KV 权限） |
   | `CF_ACCOUNT_ID` | Cloudflare 账户 ID |
   | `BANGUMI_TOKEN` | bgm.tv OAuth access token |
   | `BANGUMI_REFRESH_TOKEN` | bgm.tv OAuth refresh token |
   | `BANGUMI_CLIENT_ID` | bgm.tv OAuth App client_id |
   | `BANGUMI_CLIENT_SECRET` | bgm.tv OAuth App client_secret |
   | `CRON_SECRET` | 自定义随机字符串（用于 cron 同步认证） |

   **Variables:**
   | 名称 | 说明 |
   |------|------|
   | `BANGUMI_USERS` | bgm 用户名（逗号分隔，如 `user1,user2`） |
   | `BANGUMI_PRIMARY_USER` | primary 模式下的主账户名 |

3. **Push 到 dev 分支**

   ```bash
   git push origin dev
   ```

   GitHub Actions 将自动：
   - 检查并创建 Cloudflare KV 和 R2 资源
   - 构建前端
   - 注入环境变量
   - 部署 Worker 和 Pages

4. **等待部署完成**，访问 `https://bangumi-tv.<YOUR_SUBDOMAIN>.workers.dev`

## 前端接入

在任意页面中引入 Widget：

```html
<link rel="stylesheet" href="https://bangumi-tv.<YOUR>.workers.dev/src/bangumi.css">
<script>
  const bgmConfig = {
    apiUrl: "https://bangumi-tv.<YOUR>.workers.dev",
    quote: "生命不止，追番不息！"
  }
</script>
<script src="https://bangumi-tv.<YOUR>.workers.dev/src/bangumi.js"></script>
<div class="bgm-container"></div>
```

## 管理页面

访问 `https://<worker>/manage` 进行多账户同步：

1. 输入两个 bgm.tv 用户名
2. 依次完成 OAuth 授权
3. 选择完整同步或部分同步
4. 执行同步

## 本地开发

```bash
pnpm install
npx wrangler dev
```

Worker 启动在 `http://localhost:8787`。

## 环境变量说明

| 变量 | 类型 | 说明 |
|------|------|------|
| `SYNC_MODE` | var | `merge` 或 `primary` |
| `NSFW_SHOW` | var | 是否展示 R18 条目（`true`/`false`） |
| `BANGUMI_TOKEN` | secret | bgm.tv access token |
| `BANGUMI_REFRESH_TOKEN` | secret | bgm.tv refresh token |
| `BANGUMI_USERS` | secret | bgm 用户名列表 |
| `BANGUMI_PRIMARY_USER` | secret | 主账户名 |
| `BANGUMI_CLIENT_ID` | secret | OAuth App client_id |
| `BANGUMI_CLIENT_SECRET` | secret | OAuth App client_secret |
| `CRON_SECRET` | secret | cron 同步认证密钥 |

## 感谢

- [bangumi/api](https://github.com/bangumi/api) 提供 API
- [GeeKaven/BangumiTV](https://github.com/GeeKaven/BangumiTV) 原始项目
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: rewrite README for Cloudflare migration"
```

---

### Task 19: 最终验证和 push

- [ ] **Step 1: 检查所有文件**

```bash
git status
ls src/storage/ src/sync/ src/api/ src/image/ src/manage/ workers/ manage/ public/ .github/workflows/
```

- [ ] **Step 2: 确认目录结构符合设计**

确认旧文件已删除、新文件已创建。

- [ ] **Step 3: Push 到远程**

```bash
git push origin dev
```

- [ ] **Step 4: 检查 GitHub Actions 运行状态**

前往 Repo → Actions 查看 `Deploy to Cloudflare` 工作流是否成功。

- [ ] **Step 5: 验证线上功能**

```bash
curl https://<worker>/api/collections?type=watching
curl https://<worker>/api/calendar
curl https://<worker>/api/config?key=nsfw
curl https://<worker>/manage
```
