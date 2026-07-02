# BangumiTV Cloudflare 迁移设计方案

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

```
POST /__cron/sync   （由 Cloudflare Cron Triggers 触发，需 secret header 校验）
```

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

每 4 小时一次（通过 `SYNC_INTERVAL` 环境变量可配）。

### 执行流程

```
Cron 触发 → Worker /__cron/sync（校验 secret header）
  1. 遍历 BANGUMI_USERS 中的每个用户
     GET /v0/users/{user}/collections?subject_type=2
     分页获取，每页 50 条，请求间隔 200ms（控制 rate limit）
  2. 对所有去重后的 subject_id
     GET /v0/subjects/{subject_id} 获取条目详情 + 图片
     对 images.large URL 下载并计算 content hash
     触发图片缓存预热（fire-and-forget，不阻塞同步）
  3. 按 SYNC_MODE 合并
     merge：所有用户取并集，同一条目以最新 updated_at 为准
     primary：以 BANGUMI_PRIMARY_USER 的数据为准（写回同步在管理页面手动触发）
  4. 写入 KV：collections:merged, calendar
  5. 更新元数据时间戳
```

### Stale-while-revalidate

前端发起 `/api/collections` 请求时：
- KV 数据未过期（距上次更新 < 5 分钟）→ 直接返回
- KV 数据已过期 → 先返回旧数据，后台异步刷新

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
SYNC_INTERVAL = "4h"

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

# 定时同步，每 4 小时
[triggers]
crons = ["0 */4 * * *"]

# 公开环境变量
[vars]
SYNC_MODE = "merge"
NSFW_SHOW = "true"
SYNC_INTERVAL = "4h"

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
