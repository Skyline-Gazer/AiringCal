# @airing-cal/v3-read-worker

Cloudflare Workers entry for the v3 read gateway (#72): serves the v2-compatible
`/api/*` public surface, `/image/:hash`, and the widget assets from an R2-backed
v3 public store.

**Non-production.** CI does not deploy this Worker; `apps/web-worker` remains the
only deployed Worker. Production cutover is gated on #73 DoD.

## Layout

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Worker entry: static/widget and 410 sync routes first, then the R2 read gateway |
| `src/index.test.ts` | Entry tests over a real builder checkpoint published into a memory R2 double |
| `wrangler.toml` | Binding `AIRINGCAL_PUBLIC_R2` (`airing-cal-public`) |
| `scripts/staging-smoke.ts` | Local end-to-end smoke over `wrangler dev -l` (no remote resources) |
| `env.example` | Local vars; bindings live in `wrangler.toml` |

## Local

```bash
pnpm install
pnpm -F @airing-cal/v3-read-worker dev          # wrangler dev -l
pnpm -F @airing-cal/v3-read-worker test
pnpm -F @airing-cal/v3-read-worker smoke        # publish fixture → seed local R2 → assert HTTP surface

pnpm -F @airing-cal/v3-read-worker build:check  # wrangler deploy --dry-run (bundle must stay node-free)
```

`V3_READ_SMOKE_PORT` overrides the smoke's dev-server port (default `8799`).

The smoke seeds a local R2 emulation with `wrangler r2 object put --local` and
asserts `/api/version`, `/api/health`, `/api/collections`, `/api/calendar`,
`/api/config`, `/image/:hash`, `/`, and the 410 sync route.

## Deploy (staging only, operator)

```bash
pnpm exec wrangler r2 bucket create airing-cal-public      # if absent
pnpm -F @airing-cal/v3-read-worker exec wrangler deploy --config wrangler.toml
```

No paid resource is provisioned by CI. See
[`docs/v3/cloudflare-read-worker.md`](../../docs/v3/cloudflare-read-worker.md)
for the staging runbook, the R2 ETag/precondition contract, and the remaining
gaps (#69 matrix, real-bucket verification, EdgeOne).
