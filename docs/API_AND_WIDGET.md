# AiringCal v3.0.0 — HTTP Read API & Widget Integration Guide

[English](API_AND_WIDGET.md) | [简体中文](API_AND_WIDGET.zh-CN.md)

The AiringCal Cloudflare Reader Worker (`apps/v3-read-worker`) exposes a **strictly read-only (`GET` / `HEAD` / `OPTIONS`) HTTP surface** backed by immutable content-addressed snapshots in a private Cloudflare R2 bucket.

---

## 1. Method & Security Policy

- **Allowed HTTP Methods**: `GET`, `HEAD` (and `OPTIONS` for CORS preflight when `AIRINGCAL_CORS_ORIGINS` is configured).
- **Non-Read Methods**: `POST`, `PUT`, `PATCH`, `DELETE` return HTTP `405 Method Not Allowed` with `Allow: GET, HEAD`.
- **Retired v2 Write Routes**: `/api/sync/apply`, `/api/sync/compare`, and `/api/check/*` return HTTP `410 Gone` (`Cache-Control: no-store`) for every HTTP method.
- **Private Checkpoint Isolation**: Any request outside the allowlisted public routes — including `/checkpoints/*`, URL-encoded `%63heckpoints/*`, or traversal paths `/public/..%2f..%2fcheckpoints/*` — returns HTTP `404 Not Found` before touching R2.

---

## 2. Web Reader & Widget Static Assets

| Path | Content-Type | Cache-Control | Description |
| :--- | :--- | :--- | :--- |
| `GET /` | `text/html; charset=utf-8` | `public, max-age=300` | Standalone Web Reader HTML application |
| `GET /src/bangumi.js` | `application/javascript; charset=utf-8` | `public, max-age=300` | Embeddable Widget script |
| `GET /src/bangumi.css` | `text/css; charset=utf-8` | `public, max-age=300` | Embeddable Widget stylesheet |

### Embedding the Widget in an External Website or Blog

1. **Configure Exact-Origin CORS on Your Worker**:
   Set `AIRINGCAL_CORS_ORIGINS` (comma-separated exact origins, no `*` wildcards) on your Worker or in your `.env.production` before deploying:
   ```text
   AIRINGCAL_CORS_ORIGINS=https://blog.example.com,https://www.example.com
   ```
2. **Add the Embed Snippet to Your Page**:
   ```html
   <link rel="stylesheet" href="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.css">

   <div class="bgm-container"></div>

   <script>
     window.bgmConfig = {
       apiUrl: 'https://airingcal-production.<your-subdomain>.workers.dev',
       quote: 'My Anime Airing Calendar & Progress'
     };
   </script>
   <script src="https://airingcal-production.<your-subdomain>.workers.dev/src/bangumi.js"></script>
   ```

Every `.bgm-container` on the page mounts its own instance (multiple embeds are supported). The script exposes no global helpers: `window.bgmConfig` is read-only input, and the host document's `html`/`body` styles, URL and scroll position are left untouched.

---

## 3. JSON Read API Endpoints

Every JSON endpoint is available both under `/api/<route>` and `<route>` (for example, `/api/collections` and `/collections`).

### 3.1 `GET /api/collections`

Returns a paginated list of anime subjects from the active published release snapshot.

**Query Parameters**:

| Parameter | Type / Allowed Values | Default | Description |
| :--- | :--- | :--- | :--- |
| `type` | `watching` \| `want` \| `watched` \| `on_hold` \| `dropped` \| `1`..`5` | `watching` | Collection category (`1=want`, `2=watched`, `3=watching`, `4=on_hold`, `5=dropped`) |
| `page` | Positive integer (`>= 1`) | `1` | 1-based page number |
| `limit` | Integer `1..100` | `24` | Items per page |
| `nsfw` | `hide` \| `show` | `show` (all items) | Presentation filter applied **before** totals and pagination. `hide` removes NSFW subjects so `total`, page size and rows stay consistent. Not an authorization boundary. |

Conditional requests use a release-derived `ETag`; the `hide` variant carries its own validator, so the two representations never share a cache entry.

**Headers**:
- `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=30`

**Example Response (`200 OK`)**:

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

Returns the 7-day weekly broadcast schedule enriched with the user's personal collection state (`watching`, `want`, etc.).

- **Headers**: `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=30`
- **Response (`200 OK`)**: Array of 7 weekday objects (`weekday: { en, cn, ja, id }`, `items: [...]`).

---

### 3.3 `GET /api/health`

Returns release lineage health, subject counts, and external scheduler metadata.

- **Headers**: `Cache-Control: public, max-age=15, s-maxage=30`
- **Example Response (`200 OK`)**:

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

Returns public reader configuration flags.

- **Query Parameters**: `key=nsfw` (optional)
- **Headers**: `Cache-Control: public, max-age=60`
- **Response (`200 OK`)**: `{ "nsfw": true }` (controlled by the `NSFW_SHOW` Worker variable; defaults to `true` unless `NSFW_SHOW` is `"false"`).

---

### 3.5 `GET /api/version`

Returns runtime, package and build-source metadata. `build.commitSha` is the `BANGUMI_GIT_COMMIT_SHA` the Worker was deployed with, omitted when unset; the Update preflight compares it with the release commit.

- **Headers**: `Cache-Control: no-store`
- **Response (`200 OK`)**:

```json
{
  "app": "airingcal",
  "read": "cloudflare",
  "platform": "cloudflare",
  "package": "3.0.0",
  "build": { "commitSha": "<40-hex>" }
}
```

---

## 4. Content-Addressed Cover Image Route (`GET /image/:hash`)

- **Path**: `/image/<64-lowercase-hex-sha256>`
- **Query Parameters**:
  - `variant=thumb` (or `size=thumb` / `thumb=1`): serves the pre-generated WebP thumbnail (`images/<hash>/thumb.v2.webp` → fallback `thumb.v1.webp` → fallback `original`).
  - Default (no query): serves `images/<hash>/original` with content-sniffed MIME type (`image/webp`, `image/jpeg`, `image/png`, `image/gif`, `image/avif`) and `X-Content-Type-Options: nosniff`.
- **Headers**: `Cache-Control: public, max-age=31536000, immutable` (or `302 Found` redirect when an optional external `AIRINGCAL_IMAGE_BASE_URL` CDN is configured).

---

## 5. Controlled Public Object Interface

With the R2 bucket private, the Reader Worker exposes an allowlisted read-only object interface for release verification and compatible readers:

| Route Pattern | Mapped R2 Key | Cache-Control |
| :--- | :--- | :--- |
| `GET /public/current-release.json` | `public/current-release.json` | `public, max-age=0, must-revalidate` |
| `GET /public/manifest.json` | `public/manifest.json` | `public, max-age=0, must-revalidate` |
| `GET /public/manifests/<gen>-<sha256>.json` | `public/manifests/<gen>-<sha256>.json` | `public, max-age=31536000, immutable` |
| `GET /snapshots/v1/<gen>-<sha256>.json` | `snapshots/v1/<gen>-<sha256>.json` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/original` | `images/<sha256>/original` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/thumb.v1.webp` | `images/<sha256>/thumb.v1.webp` | `public, max-age=31536000, immutable` |
| `GET /images/<sha256>/thumb.v2.webp` | `images/<sha256>/thumb.v2.webp` | `public, max-age=31536000, immutable` |

All responses on `/public/*`, `/snapshots/*`, and `/images/*` include `X-Content-Type-Options: nosniff`. Keys are reconstructed exclusively from regex-validated digits and 64-character lowercase hex digests, never from raw path passthrough.
