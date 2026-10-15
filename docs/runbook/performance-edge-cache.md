# 读路径性能与边缘缓存（P0–P2）

面向 `airingcal` 公开读 Worker（`apps/web-worker`）与 Cloudflare 控制台配合项。

## 已实现（代码）

| 层级 | 行为 |
|------|------|
| P0 前端 | `health` 与 `collections` 并行；footer `cache.js` 复用 `window.bgmFetchHealth`；日历按 weekday `IntersectionObserver` 懒渲染 |
| P1 API | `/api/calendar`、`/api/collections` 响应带 `s-maxage` + `stale-while-revalidate` |
| P1 Thumb | 新生成 `thumb.v2.webp`（320×427 WebP q78）；`GET …/thumb` 优先 v2，回退 v1 |
| P2 图片 | Worker `caches.default` 缓存 `GET /image/*`；响应含 `CDN-Cache-Control` |

## Cloudflare 控制台（建议，与代码叠加）

同步发布成功后，若仍见 API TTFB 偏高，在 Zone 增加 **Cache Rules**（示例）：

1. **Calendar JSON**  
   - If: URI Path equals `/api/calendar`  
   - Then: Cache eligibility = Eligible for cache；Edge TTL = 10 minutes；Respect origin `Cache-Control`

2. **Cover images**  
   - If: URI Path starts with `/image/`  
   - Then: Cache eligibility = Eligible for cache；Edge TTL = 1 year

3. **Purge**  
   - 每次 QingLong/sync 完成并切换 snapshot 后：`Purge Everything` 或按 prefix purge `/api/calendar`、`/api/collections`（避免 stale 条目超过 SWR 窗口）。

## Thumb v2 回填

- Cron `15 * * * *` UTC 与 `POST /api/thumb-gen` 会写入 `thumb.v2.webp`。  
- 仅有 v1 的对象会在下次 backfill/gen 时补 v2。  
- 读路径在 v2 缺失时仍用 v1，无中断。

## 验证

```bash
curl -sSI 'https://<site>/api/calendar' | rg -i cache-control
curl -sSI 'https://<site>/image/<hash>/thumb' | rg -i 'cache-control|cdn-cache'
```

浏览器：Network 硬刷新 → 确认 `collections` 不再等待 `health` 完成才开始；切日历仅今天 section 立即出现大量 `thumb` 请求。
