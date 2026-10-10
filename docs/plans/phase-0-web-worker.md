# Phase 0 — single web Worker

Status: **implemented on `dev`** (single Worker deploy).

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
- **`GET /api/version`** — deploy verification JSON (`package.version`, git SHA, optional `build.built_at`). Spec: [docs/reference/web-worker-public-api.md](../reference/web-worker-public-api.md).
- Removed from product surface: `/api/sync/*`, `/api/check/*` → **410** JSON `DEPRECATED`; widget sync tab removed.
- Not deployed: `sync-worker`, `media-worker`, legacy `frontend-worker` / `read-worker` (see each `ARCHIVED.md`).

## Verification

```bash
pnpm install
pnpm test
pnpm build:check
pnpm dev   # @airing-cal/web-worker
```

Production deploy check (after CI or manual deploy):

```bash
curl -sS 'https://<custom-domain>/api/version' | jq
# expect git.commit_short == resolved deploy SHA (first 7 chars)
# expect package.version == apps/web-worker/package.json
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
| AC-0-11 | `/api/version` | `version.ts` + deploy `[vars]` + [web-worker-public-api.md](../reference/web-worker-public-api.md) |

## Next (Phase 1+)

- `apps/node-jobs` — D1 + R2 write path (Route A).
- QINGLONG-REPO — `airingcal-sync.js` / `airingcal-backup.js` consuming monorepo bundle (no submodule).
