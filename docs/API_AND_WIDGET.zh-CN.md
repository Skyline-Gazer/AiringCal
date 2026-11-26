# AiringCal v3.0.0 — HTTP 只读 API 与 Widget 集成指南

[English](API_AND_WIDGET.md) | [简体中文](API_AND_WIDGET.zh-CN.md)

AiringCal Cloudflare Reader Worker（`apps/v3-read-worker`）基于私有 Cloudflare R2 存储桶中的不可变内容寻址快照，对外提供 **严格只读（`GET` / `HEAD` / `OPTIONS`）的 HTTP 接口与静态资源**。

---

## 1. 请求方法与安全策略

- **允许的 HTTP 方法**：`GET`、`HEAD`（以及在配置了 `AIRINGCAL_CORS_ORIGINS` 时的 `OPTIONS` 跨域预检）。
- **拒绝非只读方法**：`POST`、`PUT`、`PATCH`、`DELETE` 均返回 HTTP `405 Method Not Allowed`（含 `Allow: GET, HEAD`）。
- **已退役的 v2 写入路由**：`/api/sync/apply`、`/api/sync/compare` 与 `/api/check/*` 对所有 HTTP 方法均返回 HTTP `410 Gone`（`Cache-Control: no-store`）。
- **私有 Checkpoint 严格隔离**：任何不在公开白名单内的请求 —— 包括 `/checkpoints/*`、URL 编码变体 `%63heckpoints/*` 或路径穿越 `/public/..%2f..%2fcheckpoints/*` —— 在读取 R2 之前即直接返回 HTTP `404 Not Found`。

---

## 2. Web 阅读器与 Widget 静态资源

| 路径 | Content-Type | Cache-Control | 说明 |
| :--- | :--- | :--- | :--- |
| `GET /` | `text/html; charset=utf-8` | `public, max-age=300` | 独立 Web 阅读器 HTML 页面 |
| `GET /src/bangumi.js` | `application/javascript; charset=utf-8` | `public, max-age=300` | 可嵌入 Widget 核心脚本 |
| `GET /src/bangumi.css` | `text/css; charset=utf-8` | `public, max-age=300` | 可嵌入 Widget 样式表 |
| `GET /src/cache.js` | `application/javascript; charset=utf-8` | `public, max-age=300` | 浏览器本地缓存辅助脚本 |

### 将 Widget 嵌入外部网站或个人博客

1. **在 Worker 上配置精确源站 CORS 白名单**：
   在部署或更新前设置 `AIRINGCAL_CORS_ORIGINS`（逗号分隔的精确 Origin 列表，严禁使用 `*` 通配符）：
   ```text
   AIRINGCAL_CORS_ORIGINS=https://blog.example.com,https://www.example.com
   ```
2. **在博客页面中嵌入以下代码片段**：
   ```html
   <link rel="stylesheet" href="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.css">

   <div class="bgm-container"></div>

   <script>
     window.bgmConfig = {
       apiUrl: 'https://airingcal-production.<your-subdomain>.workers.dev',
       quote: '我的追番日历与观看进度'
     };
   </script>
   <script src="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.js"></script>
   ```

---

## 3. JSON 只读 API 端点说明

所有 JSON 接口均同时支持 `/api/<route>` 与 `<route>` 两种路径（例如 `/api/collections` 与 `/collections` 等价）。

### 3.1 `GET /api/collections`

从当前已发布的 Release 快照中分页查询、搜索并排序动画收藏条目。

**查询参数（Query Parameters）**：

| 参数名 | 类型 / 允许值 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `type` | `watching` \| `want` \| `watched` \| `on_hold` \| `dropped` \| `1`..`5` | `watching` | 收藏分类（`1=想看`, `2=看过`, `3=在看`, `4=搁置`, `5=抛弃`） |
| `page` | 正整数 (`>= 1`) | `1` | 页码（从 1 开始） |
| `limit` | 整数 `1..100` | `24` | 每页返回条数 |
| `q` | 字符串 | `""` | 不区分大小写的关键词搜索，匹配原名（`name`）或中文名（`name_cn`） |
| `sort` | `updated_at` \| `rate` \| `date` \| `name` | `updated_at` | 排序字段（`updated_at`、`rate`、`date` 为降序，`name` 为升序） |
| `user_id` | 字符串 | 主用户 | 多用户快照下的可选用户 ID 过滤 |

**响应头**：
- `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=30`

**响应示例 (`200 OK`)**：

```json
{
  "data": [
    {
      "subject_id": 400101,
      "subject_type": 2,
      "type": 3,
      "rate": 9,
      "ep_status": 22,
      "vol_status": 0,
      "updated_at": "2026-11-26T12:00:00.000Z",
      "comment": "",
      "tags": ["TV", "2024"],
      "private": false,
      "subject": {
        "id": 400101,
        "type": 2,
        "name": "Sousou no Frieren",
        "name_cn": "葬送的芙莉莲",
        "summary": "...",
        "nsfw": false,
        "date": "2023-09-29",
        "eps": 28,
        "total_episodes": 28,
        "images": {
          "large": "/image/0000000000000000000000000000000000000000000000000000000000061ae5",
          "common": "/image/0000000000000000000000000000000000000000000000000000000000061ae5?variant=thumb"
        },
        "rating": { "score": 9.1, "rank": 12, "total": 5200 }
      }
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 24,
  "totalPages": 1
}
```

---

### 3.2 `GET /api/calendar`

返回融合了个人收藏状态（`watching`、`want` 等）的七日放送时间表。

- **响应头**：`Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=30`
- **响应格式 (`200 OK`)**：包含 7 个星期对象的数组（`weekday: { en, cn, ja, id }`、`items: [...]`）。

---

### 3.3 `GET /api/health`

返回当前 Release 代数、发布时间、条目总数与外部调度器状态。

- **响应头**：`Cache-Control: public, max-age=15, s-maxage=30`
- **响应示例 (`200 OK`)**：

```json
{
  "ok": true,
  "status": "healthy",
  "release": {
    "release_id": "1-8f3c...",
    "generation": 1,
    "published_at": "2026-11-26T13:59:30.000Z"
  },
  "counts": {
    "total_subjects": 589
  },
  "scheduler": "external"
}
```

---

### 3.4 `GET /api/config`

返回公开阅读器配置项。

- **查询参数**：`key=nsfw`（可选）
- **响应头**：`Cache-Control: public, max-age=60`
- **响应格式 (`200 OK`)**：`{ "nsfw": true }`（由 Worker 环境变量 `NSFW_SHOW` 控制；除非 `NSFW_SHOW` 显式设为 `"false"`，否则默认返回 `true`）。

---

### 3.5 `GET /api/version`

返回运行时平台与软件包版本信息。

- **响应头**：`Cache-Control: public, max-age=60`
- **响应示例 (`200 OK`)**：

```json
{
  "read": "cloudflare",
  "platform": "cloudflare",
  "schema_version": 1,
  "package": "3.0.0"
}
```

---

## 4. 内容寻址封面图片路由 (`GET /image/:hash`)

- **路径格式**：`/image/<64位小写十六进制sha256>`
- **查询参数**：
  - `variant=thumb`（或 `size=thumb` / `thumb=1`）：优先返回预生成的 WebP 缩略图（`images/<hash>/thumb.v2.webp` → 回退 `thumb.v1.webp` → 回退 `original`）。
  - 默认（无参数）：返回 `images/<hash>/original`，自动通过文件魔数嗅探 MIME 类型（`image/webp`、`image/jpeg`、`image/png`、`image/gif`、`image/avif`）并附带 `X-Content-Type-Options: nosniff`。
- **响应头**：`Cache-Control: public, max-age=31536000, immutable`（当配置了可选外部图片 CDN `AIRINGCAL_IMAGE_BASE_URL` 时返回 `302 Found` 跳转）。

---

## 5. 受控公开对象接口 (Controlled Public Object Interface)

由于 R2 存储桶处于私有状态，Reader Worker 暴露了一组严格白名单化的只读对象路由，供线上验收工具及兼容读取器消费：

| 路由模式 | 映射的 R2 对象键 | Cache-Control |
| :--- | :--- | :--- |
| `GET /public/current-release.json` | `public/current-release.json` | `public, max-age=0, must-revalidate` |
| `GET /public/manifest.json` | `public/manifest.json` | `public, max-age=0, must-revalidate` |
| `GET /public/manifests/<gen>-<sha256>.json` | `public/manifests/<gen>-<sha256>.json` | `public, max-age=31536000, immutable` |
| `GET /snapshots/v1/<gen>-<sha256>.json` | `snapshots/v1/<gen>-<sha256>.json` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/original` | `images/<sha256>/original` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/thumb.v1.webp` | `images/<sha256>/thumb.v1.webp` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/thumb.v2.webp` | `images/<sha256>/thumb.v2.webp` | `public, max-age=31536000, immutable` |

`/public/*`、`/snapshots/*` 与 `/images/*` 的所有响应均携带 `X-Content-Type-Options: nosniff`。R2 对象键完全由正则捕获的十进制代数与 64 位小写十六进制摘要拼接生成，绝不透传原始 URL 路径。
