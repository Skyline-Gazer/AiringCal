# Phase 0 — single web Worker

Status: implemented on branch `feat/phase0-web-worker` → PR to `dev`.

## Goal

Minimize Cloudflare Workers count on Free Plan: **one** public deploy target that serves UI + read API.

## Production deploy

| Item | Value |
|------|--------|
| App | [`apps/web-worker`](../../apps/web-worker/) |
| Wrangler `name` | `airing-cal-frontend` (keep custom domains) |
| GitHub job | `deploy_web_worker` in [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) |
| D1 migrations | materialize `apps/web-worker/wrangler.toml` |

Bindings (checked-in): `AIRING_CAL_D1`, `AIRING_CAL_KV`, `AIRING_CAL_R2`, `AIRING_CAL_DATA_R2` — no service bindings.

## Behavior

- Merges former `frontend-worker` + `read-worker` (`read-api.ts`, `health.ts`, `r2-snapshot.ts`).
- Public routes: `/`, `/src/*`, `/api/*`, `/image/*`.
- Removed from product surface: `/api/sync/*`, `/api/check/*` → **410** JSON `DEPRECATED`; widget sync tab removed.
- Not deployed: `sync-worker`, `media-worker`, legacy `frontend-worker` / `read-worker` (see each `ARCHIVED.md`).

## Verification

```bash
pnpm install
pnpm test
pnpm build:check
pnpm dev   # @airing-cal/web-worker
```

## Issue map (Project #5)

| ID | Title | Done when |
|----|-------|-----------|
| AC-0-01 | SPEC/PLAN | this file + README Phase 0 section |
| AC-0-02 | web-worker scaffold | `apps/web-worker/` package + wrangler |
| AC-0-03 | read routes | `read-api.ts` + tests |
| AC-0-04 | frontend/static | `index.ts` serves widget |
| AC-0-05 | deprecated sync | 410 + widget UI removed |
| AC-0-06 | deploy workflow | single `deploy_web_worker` job |
| AC-0-07 | archive sync/media | `ARCHIVED.md` on legacy apps |
| AC-0-08 | wrangler bindings | D1/KV/R2 in web-worker toml |
| AC-0-09 | CI green | `pnpm test` + `build:check` |
| AC-0-10 | README | architecture diagram + Phase 0 table |

## Next (Phase 1+)

- `apps/node-jobs` — D1 + R2 write path (Route A).
- QINGLONG-REPO — `airingcal-sync.js` / `airingcal-backup.js` consuming monorepo bundle (no submodule).
