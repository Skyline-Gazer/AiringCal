# VPS data-plane build verification

Date: 2026-09-18 (Asia/Shanghai)
Change: `migrate-data-plane-to-vps`
Base: `2cabe20` (`docs(vps-sync): check off documentation sync`)

## Result

The repository and static delivery gates pass locally. No implementation fix
was required, so this task adds only this report. PostgreSQL service tests,
container build/runtime checks, GHCR registry checks, network checks, and
production shadow/restore/cutover were not claimed as passed because the
current environment has no Docker CLI or disposable PostgreSQL service.

## Fresh command evidence

| Gate | Command | Result |
| --- | --- | --- |
| Full repository tests | `CI=true pnpm test` | exit 0; workspace tests and `scripts/*.test.mjs` passed, 0 failures |
| Full typecheck | `CI=true pnpm typecheck` | exit 0; all 10 checked workspace packages passed |
| Full build check | `CI=true pnpm build:check` | exit 0; all worker dry-run/type checks and VPS typecheck passed |
| VPS package wrapper | `CI=true pnpm -F @airing-cal/vps-sync test` | exit 1 because `tsx` could not create its IPC pipe (`listen EPERM`) in the sandbox |
| VPS native fallback | `node --import tsx/esm --test src/**/*.test.ts` from `apps/vps-sync` | exit 0; 154 tests, 147 passed, 7 PostgreSQL integration tests skipped |
| PostgreSQL integration selection | `node --import tsx/esm --test src/postgres/migrate.test.ts src/postgres/repositories.test.ts` | exit 0; 7 passed, 7 skipped because `DATABASE_URL`/`VPS_SYNC_TEST_DATABASE=1` were not configured |
| R2 failure-injection suite | `node --import tsx/esm --test apps/vps-sync/src/publication/publish.test.ts apps/read-worker/src/r2-snapshot.test.ts apps/sync-worker/src/r2-publication.test.ts` | exit 0; 90 passed |
| Image/Compose/workflow validators | `node --test scripts/verify-vps-sync-image.test.mjs scripts/validate-vps-compose.test.mjs scripts/validate-vps-image-workflow.test.mjs` | exit 0; 24 passed |
| Validator entrypoints | `node scripts/verify-vps-sync-image.mjs`; `node scripts/validate-vps-compose.mjs`; `node scripts/validate-vps-image-workflow.mjs` | exit 0; static checks passed; image verifier warned that no `VPS_SYNC_IMAGE` was supplied |
| Documentation contract | `node --test scripts/vps-docs.test.mjs` | exit 0; 4 passed |
| OpenSpec | `pnpm exec openspec validate migrate-data-plane-to-vps --strict` | exit 0; change valid |
| Whitespace | `git diff --check` | exit 0 |

## Audit evidence

- High-confidence credential-pattern scan over tracked implementation/config
  files found no private-key, access-key, token-prefix, or long Bearer-token
  matches.
- Compose environment audit found all 12 variables from
  `deploy/vps/compose.yaml` in `.env.example`, `README.md`, the runbook, and
  the VPS architecture document.
- The exact CLI help contract
  `Usage: sync [--mode=shadow|live] [--source=scheduled|manual]` is present in
  `apps/vps-sync/src/cli.ts` and the three VPS-facing documents.
- The local `docs/example/api/bgm-api.json` contains every BGM endpoint/method
  used by the VPS runtime path: collections, subject detail, calendar,
  collection patch/post, and episode get/patch. The API contract tests passed
  29/29. Existing OAuth helpers were not changed by this task.
- The docs contract tests, Compose validator, workflow validator, and image
  verifier cover the checked-in README/config/API-facing delivery claims.

## Explicitly unexecuted gates

- `docker --version` returned `command not found`; therefore no
  `docker buildx imagetools inspect node:alpine`, `apk search`, Dockerfile
  build, container run, read-only/non-root runtime inspection, or Compose
  execution was performed. Static image and Compose validators are not a
  substitute for those runtime checks.
- No disposable PostgreSQL 17 service was available locally. The CI workflow
  declares a PostgreSQL 17 service and enables the integration flag, but CI
  itself was not invoked from this environment.
- No authenticated GHCR registry request or image push was performed. The
  GHCR-equivalent workflow validator passed, but registry immutability and
  published-image metadata remain CI/environment gates.
- No external BGM/R2/Feishu network call was made by this verification.
- No production shadow run, restore drill, seven-day observation, cutover,
  rollback, or legacy-resource retention action was performed. Those remain
  explicit follow-up/production gates for Tasks 9.3/9.4 and deployment.
