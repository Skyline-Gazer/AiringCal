# Task 7.2 report

## Status

Implementation is pushed in PR [#24](https://github.com/Skyline-Gazer/AiringCal/pull/24). At report time, the GitHub-hosted `validate` job is still running; the dependent `vps-sync-image` job has not yet run its actual Compose rendering step. This report does not claim a hosted Compose pass before that check completes.

## CLI and configuration evidence

- Local `docker compose config --help`, `docker compose run --help`, and `flock --help` could not run because this macOS worktree has neither `docker` nor `flock` installed (`command not found`).
- Docker's official Compose service reference was checked for `init`, `read_only`, `user`, `cap_drop`, and `tmpfs`; its Compose CLI references were checked for `--env-file`, `config`, and `run --rm`.
- The Linux `flock(1)` manual was checked for `flock -n <lock> <command>` non-blocking behavior.
- GitHub-hosted CI now runs `docker compose config --help`, `docker compose run --help`, `flock --help`, then renders the actual configuration with `docker compose --env-file deploy/vps/.env.example -f deploy/vps/compose.yaml config` and validates that rendered output.

## TDD evidence

### RED

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 2, fail 2
ERR_MODULE_NOT_FOUND: scripts/validate-vps-compose.mjs
```

The valid full-SHA and secure rendered-config tests failed because the validator did not yet exist. The rejection checks passed because every invocation failed before the missing validator was implemented.

### GREEN

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 4, fail 0
```

The validator rejects floating/latest/debug/short tags and unsafe rendered settings, and accepts a full 40-character SHA with the non-root, read-only, capability-dropped, writable tmpfs boundary.

## Completed verification

```text
$ sh -n deploy/vps/run-sync.sh
PASS

$ CI=true pnpm test
PASS

$ CI=true pnpm typecheck
PASS

$ CI=true pnpm build:check
PASS

$ git diff --check
PASS
```

The first full quality-gate attempt could not start because this worktree had no `node_modules` and commands such as `tsx`, `tsc`, and `wrangler` were absent. `CI=true pnpm install --frozen-lockfile` restored the lockfile-pinned dependencies; the rerun above passed.

## Commits

- `9303172 test(vps-sync): define Compose deployment contract`
- `7d37764 ops(vps-sync): add pinned one-shot VPS deployment`

## PR

- https://github.com/Skyline-Gazer/AiringCal/pull/24
- Initial check status: `validate` running; Cursor Bugbot neutral/skipped.

## Deliberately not executed

- Local `docker compose config` and `flock`: executables are absent on this host.
- Any local container pull or container run.
- GHCR login, image push, registry publication, deployment, or production sync execution.
