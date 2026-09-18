---
role: historical-design
status: superseded
superseded_by:
  - docs/superpowers/specs/2026-06-29-monorepo-multi-worker-design.md
  - docs/superpowers/specs/2026-07-22-free-plan-d1-r2-incremental-sync-design.md
---

# BangumiTV Cloudflare 迁移设计方案（历史提案）

> 本文 2026-06-16 的单 Worker、Pages、OAuth 管理页和部署期自动建资源内容仅保留为历史设计记录，不是当前配置或 runbook。当前实现以 `README.md`、4 个 `apps/*/wrangler.toml`、`.github/workflows/deploy.yml` 及下方更正为准；后文出现的“当前”“将”“自动创建”等表述都属于原提案时间点。

## 2026-07-29 当前实现更正

- 生产是 `airing-cal-frontend`、`airing-cal-read`、`airing-cal-sync`、`airing-cal-media` 四 Worker monorepo，不是单 Worker + Pages。
- 长期资源固定为 D1 `airing-cal-state`、data R2 `airing-cal-data`、image R2 `airing-cal-images`、KV `airing-cal-kv` 与 Queue `airing-cal-media`。bootstrap 手工创建或复用，routine deploy 只读 resolve。
- Worker Cron 只有 `0 20 * * *`，即每日 20:00 UTC / 次日 04:00 Asia/Shanghai；handler 只创建 live Workflow instance，没有公开 HTTP Cron route。
- D1 主表为 `collection_items`、`subject_media`、`sync_runs`、`sync_budget`、`app_state`，另有 `sync_budget_reservations` 幂等 helper。shadow publication 使用 data R2 `snapshots/v1/{generation}-{content_hash}.json`，验证后写 KV `public:current`。
- D1/data R2 当前只属于 manual shadow 权威路径。公开 collections/calendar/health/cache 仍由 read-worker 从 legacy KV `snapshot:active`/versioned keys 读取，图片来自 image R2；read-worker 虽有 D1/data R2 binding，但 handler 不消费。import、公开 read cutover 与旧 KV cleanup 只属于后续 `migrate-public-reads-from-kv` change。
- 部署固定为 immutable SHA validation → resource resolve/Cron preflight → remote D1 migration → read/media → sync/Workflow + control-plane describe → frontend。migration 失败发生在首个 Worker upload 之前。
- 发布失败保留旧公开读取：D1 pending、R2 PUT/readback 或 pointer write 未完成时可 replay，不反向回滚 D1 行。runtime 回退部署前一个兼容完整 SHA；D1/R2/KV/Queue/Workflow/Durable Object 数据和 additive migration 全部保留，不做 destructive reverse migration。
- `/api/health` 仍是 legacy KV 视图，不证明 D1/data R2 shadow 健康。D1 只持久化分类 `error_code` 和有界计数/hash；D1/R2/Queue/KV 用量分别从 Cloudflare 控制面核对。公开错误、health 和日志不得包含 OAuth/Cloudflare token、完整认证上游 body 或用户评价正文。

## 背景

将 BangumiTV 从 Vercel Serverless + 静态 JSON 架构迁移到 Cloudflare Workers + Pages。数据改为直接从 bgm.tv API 获取，条目图片缓存在 R2 中并通过内容哈希去重。前端 widget 的展示逻辑和样式保留，后端完全重写。

## 架构总览

```
                       Cloudflare
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   Pages                          Workers                 │
│  ┌──────────┐                 ┌──────────────────┐      │
│  │ index.html│── 部署 ──→    │  Pages Functions  │      │
│  │ bangumi.js│   (静态)      │  (SSR 兜底)      │      │
│  │ bangumi.css│               └──────────────────┘      │
│  └──────────┘                                           │
│       │                                                  │
│       │ GET /api/collections                             │
│       │ GET /api/calendar                                │
│       │ GET /api/config?key=nsfw                         │
│       │ GET /image/:hash?w=&fmt=                         │
│       ▼                                                  │
│  ┌─────────────────────────────────────────────────┐    │
│  │                   Worker                        │    │
│  │  ┌───────────┐  ┌───────────┐  ┌────────────┐  │    │
│  │  │ API 路由  │  │ 图片代理  │  │ 定时同步   │  │    │
│  │  │ (读 KV)  │  │ (R2 缓存) │  │ (拉 bgm)   │  │    │
│  │  └─────┬─────┘  └─────┬─────┘  └─────┬──────┘  │    │
│  └────────┼──────────────┼──────────────┼──────────┘    │
│           │              │              │                │
│           ▼              ▼              ▼                │
│     ┌─────────┐   ┌──────────┐   ┌───────────────┐     │
│     │   KV    │   │    R2    │   │  bgm.tv API   │     │
│     │收藏/日历│   │  图片    │   │  (外部)       │     │
│     └─────────┘   └──────────┘   └───────────────┘     │
└──────────────────────────────────────────────────────────┘
```

一个 Worker 处理所有：API 路由、图片代理、定时同步。Pages 只部署纯静态前端。

## 目录结构

```
BangumiTV/
├── wrangler.toml
├── package.json
├── workers/
│   └── index.ts               # Worker 入口（Hono 路由）
├── src/
│   ├── api/
│   │   ├── collections.ts     # GET /api/collections
│   │   ├── calendar.ts        # GET /api/calendar
│   │   └── config.ts          # GET /api/config
│   ├── image/
│   │   ├── proxy.ts           # 图片代理路由
│   │   └── store.ts           # R2 适配器（ImageStore 接口）
│   ├── sync/
│   │   ├── cron.ts            # 定时任务处理
│   │   ├── bgm-client.ts      # bgm.tv API 客户端
│   │   └── merger.ts          # 多账户合并逻辑
│   ├── manage/
│   │   ├── oauth.ts           # OAuth 流程
│   │   ├── compare.ts         # 账户对比逻辑
│   │   └── sync-write.ts      # 写回 bgm.tv
│   └── storage/
│       ├── adapter.ts         # StorageAdapter 接口
│       └── kv.ts              # Cloudflare KV 实现
├── public/                    # 前端 widget（部署到 Pages）
│   ├── index.html
│   └── src/
│       ├── bangumi.js
│       ├── bangumi.css
│       └── nsfw-modal.js
├── manage/
│   └── index.html             # 管理页面（由 Worker 提供，不部署到 Pages）
├── .github/
│   └── workflows/
│       └── deploy.yml          # CI/CD 部署工作流
└── build.js
```

## API 设计

所有端点由 Worker 提供。前端永远不知道 bgm.tv 的用户名、用户 ID 或 token。

### 前端公开端点（无需认证）

```
GET /api/collections?type=watching&page=1&limit=24
→ { data: [...], total: 120, page: 1, types: { want: 10, watched: 80, watching: 20, on_hold: 5, dropped: 5 } }

GET /api/calendar
→ [{ weekday: { en, cn, ja, id }, items: [...] }]

GET /api/config?key=nsfw
→ { nsfw: true }
```

### 管理后台端点（需 OAuth 授权）

```
GET  /manage                    → 管理页面 HTML（Worker 直接渲染）
GET  /manage/callback           → OAuth 回调，用 code 换 token
GET  /api/manage/compare        → 对比两个用户收藏（使用 OAuth session token）
POST /api/manage/sync           → 执行同步
```

```
GET  /api/manage/compare?userA=<name>&userB=<name>
     → { userA: { collections: {...}, total: 120 }, userB: { ... }, common: 60 }
     两个用户都完成 OAuth 后才能返回数据。

POST /api/manage/sync
     Body: { mode: "full" | "partial", from: "userA", to: "userB", subject_ids: [1,2,3] }
     → { results: [{ subject_id, status: "ok"|"error" }] }
```

### 图片代理

```
GET /image/:contentHash?w=<宽度>&fmt=webp|avif|jpeg
→ 返回处理后图片，带 Cache-Control: public, max-age=31536000
```

`contentHash` = 图片原始字节的 SHA256。不同条目如果 bgm.tv 用了同一张图，共用一个缓存。

### 内部端点

当前没有 HTTP Cron 端点。生产自动同步由 `airing-cal-sync` Worker 的
`scheduled` handler 创建 live Workflow instance；手动运行、查询、重启和终止
通过 Cloudflare Workflow 控制面完成，不暴露带 secret header 的同步路由。

## KV 存储

Cloudflare KV 的 key 结构：

```
collections:merged    → { want: [...], watched: [...], watching: [...], on_hold: [...], dropped: [...], updated_at: "ISO时间" }
calendar              → [{ weekday: {...}, items: [...] }]
```

收藏条目数据格式：
```json
{
  "subject_id": 123,
  "name": "進撃の巨人",
  "name_cn": "进击的巨人",
  "summary": "...",
  "images": { "hash": "abc123", "w": 400, "h": 600 },
  "eps": 25,
  "total_episodes": 25,
  "ep_status": 25,
  "type": 2,
  "rate": 8,
  "nsfw": false,
  "date": "2013-04-07"
}
```

图片存为 `{ hash, w, h }`，不暴露任何 bgm.tv CDN 地址到前端。

## 图片代理 & R2

### 处理流程

```
GET /image/abc123?w=300&fmt=webp
  1. 查 R2: images/abc123/w300.webp
  2. 命中 → 直接返回，带上长缓存头
  3. 未命中:
     a. 查 R2: images/abc123/original
     b. 没有 → 通过 `GET /v0/subjects/{id}` 的 `images.large` 找到源图并下载
     c. 存为 images/abc123/original
     d. Worker 内裁切 + 转格式（Cloudflare Image Resizing 或 wasm sharp）
     e. 存变体 images/abc123/w300.webp
     f. 返回
```

### 支持的变体宽度

200, 300, 400, 600（original 保留原始尺寸备用）。保持宽高比，不限制高度。

### R2 目录结构

```
images/
  <contentHash>/
    original          ← 从 bgm.tv CDN 下载的原图
    w200.webp
    w300.webp
    w400.webp
    w600.webp
```

### ImageStore 接口

```ts
interface ImageStore {
  getOriginal(hash: string): Promise<ArrayBuffer | null>
  putOriginal(hash: string, data: ArrayBuffer, contentType: string): Promise<void>
  getVariant(hash: string, variant: string): Promise<ArrayBuffer | null>
  putVariant(hash: string, variant: string, data: ArrayBuffer): Promise<void>
}
```

Cloudflare 用 R2 实现。换平台只需实现这个接口。

## StorageAdapter 接口

KV 存储的抽象层（方便未来切换 Redis / EdgeOne KV）：

```ts
interface StorageAdapter {
  get<T>(key: string): Promise<T | null>
  put<T>(key: string, value: T, ttl?: number): Promise<void>
  delete(key: string): Promise<void>
}
```

当前实现：Cloudflare KV。换平台只需实现新的 adapter。

## 定时同步（Cron Job）

### 频率

当前生产止血 schedule 固定为每天 04:00 Asia/Shanghai，即 20:00 UTC；不通过运行时变量绕过日级媒体预算。

### 执行流程

```
Worker Cron scheduled event → production.ts → 创建 live SyncWorkflow instance
  1. Workflow 分页获取 BANGUMI_USERS 的 collections（每页 50 条）与 calendar，写入 instance staging KV
  2. 生成五类 collection、calendar 与 summary 的 generation-scoped snapshot，提交前不改变 active pointer
  3. 每 10 个 subject 有界读取 detail/meta/image/refresh 状态，只为缺失、源变化、到期或 retry 生成候选
  4. 候选按 new/changed、hot due、7 日 cold shard、retry 排序；普通任务 soft limit 50，只有 new/changed 可到 hard limit 100
  5. scheduled/manual live 共享 UTC 自然日预算；SnapshotCoordinator 先持久化逻辑 reservation，再最多尝试一次 Queue producer
  6. budget exhausted 或 producer outcome uncertain 都不阻塞 snapshot commit；shadow 不预留预算、不投递 Queue
  7. Media Worker 异步获取 subject detail 与图片，并对 detail/meta/image/refresh 做 compare-before-write
```

Workflow 不逐个同步请求 subject detail、下载图片或 fire-and-forget 预热；这些媒体副作用只由 Queue consumer 执行。未变化且缓存完整、未到期的 subject 不入队，也不产生逐 subject KV PUT。

### 公开读取

前端发起 `/api/collections` 或 `/api/calendar` 请求时，Read Worker 跟随 `snapshot:active` 一次读取同一 generation 的完整 manifest；读请求不会触发后台业务同步。

## 多账户同步（管理页面）

> 历史设计更正（2026-06-26）：当前实现将本功能收窄为“多账户动画同步”，只同步 bgm.tv 动画收藏（`subject_type=2`）。写回使用 `POST /v0/users/-/collections/{subject_id}` 的新增或修改语义；动画同步写入 body 只发送 `type` 和 `rate`。不要发送 `ep_status` 或 `vol_status`，这两个字段只适用于书籍进度；也不要发送 `tags: []` 或空 `comment`，避免清空目标账号已有标签和评价。

URL：`https://<worker域名>/manage`。不在前端 widget 中暴露入口，需要知道地址才能访问。

### 步骤 1：输入用户名

输入两个 bgm.tv 用户名。

### 步骤 2：OAuth 授权

两个账号依次完成 OAuth：
- 跳转到 `https://bgm.tv/oauth/authorize?client_id=...&response_type=code&redirect_uri=https://<worker>/manage/callback&state=<userA|userB>`
- 回调 `GET /manage/callback?code=xxx&state=xxx`：Worker 用 code 换 access_token（`POST https://bgm.tv/oauth/access_token`）
- Token 存在短期 cookie 中（仅当次 session 有效，同步完成后丢弃）
- 两个账号授权完成后，展示各自的收藏概况

### 步骤 3：选择同步模式

**完整同步：**
- 选择方向：A → B 或 B → A
- 将源账户的动画收藏状态同步到目标账户
- 逐条显示执行进度

**部分同步：**
- 选择方向：A → B 或 B → A
- 列出两个账户的共有条目（相同 subject_id），并排显示当前进度差异
- 支持全选 / 单选勾选
- 只同步被选中的条目从源 → 目标

### 步骤 4：执行

- 对每个选中动画条目调用 `POST /v0/users/-/collections/{subject_id}`
- 请求体：`{ type, rate }`
- 实时显示执行进度
- 完成后展示结果汇总

## NSFW / R18 处理

### 后端

- `NSFW_SHOW` 环境变量控制 API 响应中是否包含 R18 条目
- `NSFW_SHOW=false` 时：从收藏列表中过滤掉 `nsfw: true` 的条目
- `GET /api/config?key=nsfw` 返回当前设置

### 前端

- 页面加载时检查 `GET /api/config?key=nsfw`
- 如果 nsfw === true 且 localStorage 中无 `bgm-age-confirmed` → 弹出 age-18 确认弹窗
- 用户确认 → 写入 localStorage，渲染内容
- 用户拒绝 → 跳转离开
- NSFW 条目在列表中默认模糊遮罩，点击可查看（可配置关闭模糊）

## 环境变量

```toml
# wrangler.toml - 公开变量
[vars]
SYNC_MODE = "merge"            # merge | primary
NSFW_SHOW = "true"

# Secrets（不提交 git）
BANGUMI_TOKEN                  # bgm.tv OAuth access token（cron 同步用）
BANGUMI_REFRESH_TOKEN          # bgm.tv OAuth refresh token
BANGUMI_USERS                  # 逗号分隔的 bgm 用户名列表
BANGUMI_PRIMARY_USER           # primary 模式下的主账户
BANGUMI_CLIENT_ID              # OAuth app client_id（管理页面用）
BANGUMI_CLIENT_SECRET          # OAuth app client_secret（管理页面用）
```

## wrangler.toml 配置

所有 Cloudflare 资源（KV、R2）使用固定名称，由 CI/CD 自动创建。Binding 声明在 wrangler.toml 中，Worker 代码通过 `env.<BINDING_NAME>` 访问。

```toml
name = "bangumi-tv"
main = "workers/index.ts"
compatibility_date = "2026-06-17"

# 定时同步，每天 04:00 Asia/Shanghai（20:00 UTC）
[triggers]
crons = ["0 20 * * *"]

# 公开环境变量
[vars]
SYNC_MODE = "merge"
NSFW_SHOW = "true"

# KV 命名空间（CI 自动创建）
[[kv_namespaces]]
binding = "BANGUMI_KV"
id = "bangumi-tv-kv"

# R2 存储桶（CI 自动创建）
[[r2_buckets]]
binding = "BANGUMI_R2"
bucket_name = "bangumi-tv-images"

# Worker 路由
[[routes]]
pattern = "<worker-domain>/*"
zone_name = "<zone>"
```

## CI/CD 部署（GitHub Actions）

所有部署通过 GitHub Actions 完成，不使用 wrangler CLI 手动操作。Cloudflare 的资源在 CI 阶段自动检测和创建。

### GitHub Secrets & Variables 配置

在 GitHub Repo → Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 说明 |
|------|------|------|
| Secret | `CF_API_TOKEN` | Cloudflare API Token（需 Workers/R2/KV 读写权限） |
| Secret | `CF_ACCOUNT_ID` | Cloudflare 账户 ID |
| Secret | `BANGUMI_TOKEN` | bgm.tv OAuth access token |
| Secret | `BANGUMI_REFRESH_TOKEN` | bgm.tv OAuth refresh token |
| Secret | `BANGUMI_CLIENT_ID` | bgm.tv OAuth app client_id |
| Secret | `BANGUMI_CLIENT_SECRET` | bgm.tv OAuth app client_secret |
| Variable | `BANGUMI_USERS` | bgm 用户名列表（逗号分隔） |
| Variable | `BANGUMI_PRIMARY_USER` | primary 模式主账户 |

### CI 工作流步骤

```
name: Deploy

on:
  push:
    branches: [dev]
  workflow_dispatch:           # 支持手动触发

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      1. Checkout 代码

      2. Setup Node + pnpm

      3. 安装依赖 (pnpm install)

      4. 🔧 检查并创建 Cloudflare 资源
         - 检查 KV namespace "bangumi-tv-kv" 是否存在
           → 不存在则 wrangler kv:namespace create "bangumi-tv-kv"
           → 拿到 namespace id，写入 wrangler.toml 对应的 id 字段
         - 检查 R2 bucket "bangumi-tv-images" 是否存在
           → 不存在则 wrangler r2 bucket create "bangumi-tv-images"
         - 探测 KV id 和 R2 bucket 是否就绪

      5. 构建前端 (node build.js)

      6. 注入 Secrets
         - 通过 wrangler secret put 写入所有 BANGUMI_* secrets
         - 或通过 wrangler deploy --var 传递

      7. 部署 Worker
         wrangler deploy --var SYNC_MODE:merge --var ...

      8. 部署 Pages（静态前端）
         wrangler pages deploy public/ --project-name=bangumi-tv
```

### 资源命名规范

| 资源 | 固定名称 | Binding 名 | Worker 中访问方式 |
|------|---------|-----------|------------------|
| KV Namespace | `bangumi-tv-kv` | `BANGUMI_KV` | `env.BANGUMI_KV.get(...)` |
| R2 Bucket | `bangumi-tv-images` | `BANGUMI_R2` | `env.BANGUMI_R2.get(...)` |

首次运行 CI 时自动创建这些资源，后续运行检测到已存在则跳过创建。

### CI/CD 流程总结

```
开发者 push 到 dev 分支
    │
    ▼
GitHub Actions 触发
    │
    ├─ 检查 CF 资源 → 不存在就创建（固定名字）
    ├─ 构建前端
    ├─ 注入 ENV（从 GitHub Secrets/Variables 读取）
    ├─ wrangler deploy（Worker）
    └─ wrangler pages deploy（Pages）
```

全程无需登录 Cloudflare Dashboard 手动配置。

## bgm.tv API 使用清单

| 端点 | 用途 | 认证 |
|------|------|------|
| `GET /v0/users/{user}/collections` | 获取用户收藏（分页） | Bearer（公开收藏可选） |
| `GET /v0/subjects/{subject_id}` | 获取条目详情，并以 `images.common` / `images.large` 作为 canonical 图片源 | Bearer（公开条目可选） |
| `POST /v0/users/-/collections/{subject_id}` | 写回动画同步（新增或修改） | Bearer 必须 |
| `GET /calendar` | 每日放送 | 无 |
| `POST /oauth/access_token` | 用 code 换 token | client_id/secret |

User-Agent: `markd3ng/BangumiTV (https://github.com/markd3ng/BangumiTV)`

## 文件变更清单

| 操作 | 文件 |
|------|------|
| 新增 | `workers/index.ts`, `src/**`, `manage/index.html`, `wrangler.toml`, `.github/workflows/deploy.yml` |
| 修改 | `public/index.html`, `public/src/bangumi.js`, `public/src/bangumi.css`, `build.js`, `package.json`, `README.md` |
| 删除 | `app.js`, `collection.js`, `api/serverless.js`, `data/*.json`, `vercel.json` |

## 文档更新

README.md 需完全重写，覆盖以下内容：

- **项目介绍**：说明是基于 Cloudflare Workers + Pages 的 Bangumi 追番展示工具
- **前置条件**：Cloudflare 账号、bgm.tv 账号及 OAuth App 注册、GitHub 账号
- **快速部署**：
  1. Fork 本仓库
  2. 在 GitHub Secrets 中配置 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`BANGUMI_TOKEN` 等
  3. 在 GitHub Variables 中配置 `BANGUMI_USERS`、`BANGUMI_PRIMARY_USER`
  4. Push 到 dev 分支，GitHub Actions 自动部署
- **前端接入**：更新后的 widget 引入方式（`<link>` + `<script>` + `bgmConfig`）
- **管理页面**：如何使用 `/manage` 进行多账户同步
- **本地开发**：`wrangler dev` 的使用方法
- **环境变量说明**：所有变量的含义和配置方式
- **删除 Vercel 相关的旧部署文档**

## 前端 Widget 变更

- `apiUrl` 指向 Worker 域名
- API 路径变更：`/bangumi` `/v2/bangumi` `/bangumi_total` → `/api/collections`
- 新增 NSFW 弹窗组件
- 新增 NSFW 条目模糊遮罩
- 响应数据格式适配新 API
- CSS：保留所有现有样式，新增 `.bgm-nsfw-blur` 和 `.bgm-age-modal` 样式

## 实现阶段

### 第一阶段：核心 Worker + KV
- 搭建 wrangler.toml、KV namespace、Worker 入口（Hono）
- 实现 bgm-client.ts（bgm.tv API 封装）
- 实现 cron 同步：拉收藏 → 合并 → 写 KV
- 实现公开 API：`/api/collections`, `/api/calendar`, `/api/config`
- 用 `wrangler dev` 本地验证

### 第二阶段：图片代理 + R2
- 创建 R2 bucket
- 实现 ImageStore（R2 adapter）
- 实现图片代理路由 `/image/:hash`
- 集成到 cron 同步（异步预热缓存）

### 第三阶段：管理页面
- 实现 OAuth 流程（bgm.tv 授权 → 回调 → 换 token）
- 实现账户对比接口
- 实现同步写回（PATCH collections）
- 构建管理页面 HTML + JS（Worker 提供）

### 第四阶段：前端 & 清理
- 更新 widget：新 API 路径、响应格式、NSFW 弹窗
- 按需调整 build.js
- 删除旧文件：app.js, collection.js, api/, data/, vercel.json

### 第五阶段：文档 & 部署
- 重写 README.md（项目介绍、快速部署、前端接入、本地开发、ENV 说明）
- 配置 GitHub Actions 工作流（`.github/workflows/deploy.yml`）
- 验证 CI/CD 全流程：push → 自动创建资源 → 注入 secrets → deploy
- 验证 Worker + Pages 线上可访问
