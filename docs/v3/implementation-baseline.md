# AiringCal v3 implementation baseline

Status: Working implementation baseline; governed by [Issue #67](https://github.com/Skyline-Gazer/AiringCal/issues/67) and [Skyline-Gazer Project #7](https://github.com/orgs/Skyline-Gazer/projects/7).

## Authoritative workflow

- `dev` is the integration base; `main` is aligned with `dev` as of 2026-10-16. Preserve original main at `archive/main-before-v3-alignment-20261016`.
- Work on dedicated feature branches, reviewable PRs targeting `dev`, and child Issues of #67. No direct production modification or deployment during architecture/bootstrap.
- Initial development branch `feat/v3.0.0` starts at `3.0.0-alpha.0`; avoid broad implementation commits inside the bootstrap PR. Existing v2 production workflow must not be triggered by feature-branch pushes.
- GitHub Project #7 is the authoritative task board, projects #5/#6 retired by owner. Project item/status operations must be independently verified.
- Alibaba OpenCodeReview is the selected AI reviewer, advisory initially; see #74.

## Product boundaries

- One instance represents exactly one Bangumi user. No multi-tenancy, login or user switching.
- Preserve current frontend appearance/features and public behavior. Refactor internals, not the product.
- Initial platform priority: Cloudflare and Tencent EdgeOne. Later adapters ship through incremental versions after verified platform-specific support.
- Core is portable: thin platform adapters, shared domain/Builder/Release contract, same published assets across platforms. Do not copy Xget runtime/infra blindly; Xget is a request-proxy, AiringCal is an offline builder plus static reader.

## Runtime and state

- Docker/Compose: web, scheduler, builder boundaries; single SQLite durable state on local filesystem, WAL and bounded job leases/fencing; no WAL on network storage.
- Serverless: external builder e.g. GitHub Actions and private checkpoint storage. Prevent two authoritative builders publishing one site without explicit handoff.
- Daily incremental sync and seven-day full reconciliation by default; manual sync supported. Failed core collections/calendar completeness halts publishing; previously verified subject details/images may be reused with explicit stale/partial status.
- Credential-bearing private checkpoint and published public store are separate. All published content is explicitly public allowlisted data.

## Publication and frontend

- Immutable content-addressed images and versioned Release, pointer updated only after complete verification. Require safe single-publisher coordination supported by chosen backend; otherwise fail closed.
- Default original + 320x427 WebP quality 78 thumbnail. Future image variants versioned; GC must be reference-aware, dry-run first, keep >=30d and >=5 successful releases and manual pins.
- Decide single JSON snapshot versus a few modules from measured real v2 payload and frontend read contract, **not** speculative overengineering. Readers pin a version to avoid mixing releases.
- `airingcal.yaml` with validated schema + environment/platform secret source, `airingcal setup` interactive and noninteractive. Never implicitly create billable services.

## Explicit delivery gates

1. [#69](https://github.com/Skyline-Gazer/AiringCal/issues/69) Audit real v2 read/sync behavior and Cloudflare/EdgeOne feature matrix.
2. [#70](https://github.com/Skyline-Gazer/AiringCal/issues/70) Portable Builder and SQLite.
3. [#71](https://github.com/Skyline-Gazer/AiringCal/issues/71) Release, images, frontend parity.
4. [#72](https://github.com/Skyline-Gazer/AiringCal/issues/72) CF/EdgeOne adapters, setup.
5. [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) Read-only migration, backup/restore, rollback, E2E smoke and owner-approved cutover.
6. [#74](https://github.com/Skyline-Gazer/AiringCal/issues/74) Advisory OpenCodeReview.

Do not mark a gate complete without evidence in Issue/PR and checked CI. No production cutover via merge side effects.
