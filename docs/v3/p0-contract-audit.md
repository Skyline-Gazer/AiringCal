# P0 — AiringCal v2 read/write contract audit (source verified)

Source baseline: `dev@a4b3b082d15943e11a2d5443077f9ab5f3c175dc` (2026-10-16). Owner tracking: #67 / #69 / Project #7.

Code-backed frontend/route/cache evidence: [`p0-contract-evidence.md`](./p0-contract-evidence.md).

## Verified code boundaries

| Concern | Current source | v3 treatment |
|---|---|---|
| Public HTML/CSS/JS | `apps/web-worker/src/index.ts`, `packages/widget` | Keep behavior and appearance, extract portable asset delivery |
| Public read endpoints | `apps/web-worker/src/index.ts` + `read-api.ts` | Preserve URLs and response semantics via compatibility router, or document tested breaks |
| Bangumi API | `packages/bgm-api/src/bgm-client.ts` | Reuse typed retries/pagination/error contracts within portable builder |
| Current sync | `apps/node-jobs/src/sync/pipeline.ts` | Extract domain transforms, replace D1/KV/R2-coupled orchestration with SQLite + publisher |
| Public manifest | `packages/domain/src/public-manifest.ts` | Evolve immutable snapshot/manifest with checksums and full staged verification |
| Cloudflare snapshot read | `apps/web-worker/src/r2-snapshot.ts` | Replace KV-coupled pointer with portable public release pointer and optional gateway |
| Thumbnails | `apps/web-worker/src/thumb-gen.ts` + `thumb-materialize.ts` | Move processing to Builder; retain original and 320x427 q78 WebP by default |

## Route inventory from `apps/web-worker/src/index.ts`

- Public static: `/`, `/src/bangumi.js`, `/src/bangumi.css`, `/src/cache.js`.
- Public read: `GET /api/collections`, `GET /api/calendar`, `GET /api/config`, `GET /api/health`, `GET /api/version`, `GET /api/cache`.
- Images: `/image/:hash` original; `/image/:hash/thumb` pre-materialized WebP.
- Authenticated internal mutation: `POST /api/thumb-gen` (must be retired in v3, not silently exposed).
- Legacy removed: `/api/sync/compare`, `/api/sync/apply`, `/api/check/*` -> 410 DEPRECATED.
- Headers: HTML CSP, nosniff, frame denial; CSS/JS 300s, image 31536000 immutable; read cache TTL differs by endpoint. Verify detailed status and cache semantics with tests, not this inventory alone.
- Observed index.ts embeds site verification and analytics env; v3 public config must allowlist only safe values.

## Constraints surfaced by actual code

1. Current docs identify read Worker `airing-cal-frontend` and QingLong writing `node-jobs` bundle. Do **not** treat archived VPS/Postgres designs as live production.
2. `docs/reference/web-worker-public-api.md` documents existing `thumb.v2.webp` (320x427 cover quality 78), old v1 fallback, and a Cloudflare Images binding transformation from an authenticated endpoint. v3 must remove runtime transform dependency.
3. Existing `packages/domain` has validated snapshot digest and immutable snapshot key; reuse it rather than replacing contracts wholesale.
4. Check whether a single snapshot is already economical. Do not introduce `subjects.json` by assumption; collect actual sample payload sizes and frontend network waterfall before deciding.
5. Ensure new v3 feature branch changes do not trigger the `dev`-push Cloudflare deployment path; deploy/cutover is a separate owner authorization gate.

## Initial Cloudflare / EdgeOne capability matrix (verification backlog, NOT green)

| Capability | Cloudflare | EdgeOne | Required test |
|---|---|---|---|
| Serve static frontend | candidate | candidate | paths, SPA fallback, headers |
| Thin read gateway | Workers candidate | Edge Functions candidate | Request/Response portability, size/time limits |
| Public object assets | R2 candidate | platform/object-store adapter candidate | GET, cache keys, CORS, content types |
| Safe mutable current pointer | unspecified per adapter | unspecified per adapter | CAS or externally serialized single-publisher commit; fail closed without proof |
| Scheduled Builder | external GitHub Actions | external GitHub Actions | artifact and checkpoint restore, lock safety |
| Image variants | generated offline | generated offline | hash, sizes, format, unchanged original |
| CDN cache | candidate | candidate | short mutable pointer, long immutable Release; rollback and propagation |

Platform limits/pricing/deployment permissions must be verified against current official docs and empirical staging deployments in #72; no unverified capability is an acceptance pass.

## Next engineering actions

- Record a v2 API fixture matrix (status, schema, cache headers, fallback) with automated contract tests.
- Measure actual snapshot compressed/uncompressed size and calendar/collections frontend read pattern.
- Define portable `PublicStore`, `PrivateCheckpointStore`, `Publisher`, `RuntimeAdapter` boundaries with fail-closed capabilities.
- Separate static/read adapters from offline Builder; serverless workers must never run SQLite/image processing.
- Capture test artifacts and owner-approved deployment verification in #69 / #72.

References:
- https://github.com/Skyline-Gazer/AiringCal/blob/dev/docs/README.md
- https://github.com/Skyline-Gazer/AiringCal/blob/dev/docs/reference/web-worker-public-api.md
- https://github.com/Skyline-Gazer/AiringCal/blob/dev/apps/web-worker/src/index.ts
- https://github.com/xixu-me/Xget/blob/main/src/app/handle-request.js
