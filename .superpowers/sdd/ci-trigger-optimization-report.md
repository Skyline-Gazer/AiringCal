# CI trigger optimization report

- Commit: `7b239076c8b2200a9aa6fb8595a22fca71ef2937`
- Branch: `codex/vps-run-coordinator`

## RED

`pnpm exec tsx --test packages/worker-common/src/deploy-config.test.ts` failed as expected after adding the CI trigger assertion and before changing the workflow. The failure was `CI should run on pushes to dev only`, because `.github/workflows/ci.yml` had an unrestricted `push:` trigger.

## GREEN

After updating the workflow, `pnpm exec tsx --test packages/worker-common/src/deploy-config.test.ts` passed all 9 tests. The following repository quality gates also passed:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build:check`
- `git diff --check`

## Fix round 1

The README and focused test assertion wording now describe the empty `pull_request:` trigger accurately: it has no branch/path filters and uses GitHub's default `opened`, `synchronize`, and `reopened` pull request activities. The workflow configuration and assertion preserving the filter-free `pull_request:` shape were not changed.
