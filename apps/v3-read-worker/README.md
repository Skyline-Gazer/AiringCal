# @airing-cal/v3-read-worker

Cloudflare Workers entrypoint for the AiringCal `v3.0.0` stateless read gateway: serves the standalone HTML Reader (`/`), Widget assets (`/src/bangumi.js`, `/src/bangumi.css`), read-only JSON APIs (`/api/*`), content-addressed cover images (`/image/:hash`), and the allowlisted public object interface from a private Cloudflare R2 bucket (`AIRINGCAL_R2`).

- Deployment, update & recovery guide: [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)
- HTTP Read API & Widget integration guide: [`docs/API_AND_WIDGET.md`](../../docs/API_AND_WIDGET.md)
- System architecture & security model: [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md)

## Layout

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Worker entry: static/widget and `410` sync routes first, then the R2 read gateway |
| `src/index.test.ts` | Entry tests over a builder checkpoint published into an in-memory R2 binding |
| `wrangler.toml` | Template R2 binding `AIRINGCAL_R2` (materialized per environment during `pnpm run setup`) |
| `scripts/staging-smoke.ts` | Local end-to-end smoke over `wrangler dev -l` (no remote resources) |

## Local Verification

```bash
pnpm -F @airing-cal/v3-read-worker dev          # wrangler dev -l
pnpm -F @airing-cal/v3-read-worker test
pnpm -F @airing-cal/v3-read-worker smoke        # publish fixture -> seed local R2 -> assert HTTP surface
pnpm -F @airing-cal/v3-read-worker build:check  # wrangler deploy --dry-run (bundle must stay node-free)
pnpm -F @airing-cal/widget generate             # rebuild frontend assets after editing packages/widget/src/app
pnpm e2e                                        # Playwright acceptance (Chromium, Firefox, WebKit)
```
