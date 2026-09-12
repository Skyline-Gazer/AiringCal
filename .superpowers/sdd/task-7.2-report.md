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

## Review repair evidence (2026-09-12)

### Root cause and contract verification

- `deploy/vps/run-sync.sh` passed its local `.env` directly to Compose; the SHA contract was only represented by Compose interpolation and the CI example file, so a floating host image could reach Docker.
- `scripts/validate-vps-compose.mjs` searched all rendered YAML text. An `x-irrelevant` extension could therefore supply security-looking keys while `services.sync` was insecure, and `ro,mode=1777` matched the old tmpfs regex.
- Local `docker` and `flock` remain unavailable. Docker's official `docker compose config` reference was checked before the CI change: it states that `config` renders the resolved/canonical model and documents `--format json` and `--quiet`.

### RED

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 4, fail 3

- x-irrelevant top-level security keys were accepted although services.sync lacked init.
- /tmp/airing-cal:ro,mode=1777 was accepted as writable.
- a host .env VPS_SYNC_IMAGE=...:latest reached the fake Docker boundary.
```

The first green review exposed one test gap: valid host `.env` expansion was not covered. A focused RED then produced `pass 7, fail 1`, with the valid full SHA rejected as `VPS_SYNC_IMAGE_MUST_BE_FULL_SHA` because the shell expansion was literal. The one-line correction was made only after that RED.

### GREEN

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 8, fail 0

$ sh -n deploy/vps/run-sync.sh
PASS

$ git diff --check
PASS

$ CI=true pnpm test
PASS

$ CI=true pnpm typecheck
PASS

$ CI=true pnpm build:check
PASS
```

- `run-sync.sh` accepts exactly one strict image line from its local `.env`, emits `VPS_SYNC_IMAGE_MUST_BE_FULL_SHA` before `flock` or Docker for invalid input, and removes inherited `VPS_SYNC_IMAGE` so Compose cannot override the validated host file.
- CI now asks Compose for the rendered JSON model and the validator checks only `services.sync`; the new regressions assert the explicit `SYNC_INIT_REQUIRED` and `SYNC_TMPFS_MUST_BE_WRITABLE` rejection reasons.
- README uses `config --quiet` so the local syntax/configuration check does not write interpolated secrets to stdout. It also records the existing fail-closed boundary and that actual CLI composition belongs to Task 9.3.

### Commit and hosted CI

- Fix commit: `b60aea89c21155f3d921be10efe2054347031238` (`fix(vps-sync): fail closed on host image and rendered service`), pushed to `codex/vps-task-7-2`.
- GitHub Actions run: [34670495133](https://github.com/Skyline-Gazer/AiringCal/actions/runs/34670495133), created from that commit and in progress when this evidence was recorded. It is the required real Docker Compose rendering check; this report does not claim its result before completion.

---

## Second review repair evidence (2026-09-12)

### Root cause and call semantics

- `run-sync.sh` accepted only bare `VPS_SYNC_IMAGE=...` lines but handed the same `.env` to Compose. Compose's parser accepts `export VPS_SYNC_IMAGE=...`, so a later exported floating tag could differ from the shell-validated value.
- Docker's Compose interpolation documentation confirms that the shell environment takes precedence over `--env-file`; the official `compose-go` dotenv parser confirms `export` support. A local POSIX-shell check also confirmed that `VPS_SYNC_IMAGE="$image" exec ...` exports the exact assignment to the executed command.
- The old fake Docker stub did not enable `set -e`; its failed `test -z` therefore did not fail the test process, producing a false positive.

### RED

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 7, fail 1

run-sync passes its validated image ahead of dotenv and inherited overrides
docker: VPS_SYNC_IMAGE: unbound variable
```

The regression fixture has a valid bare full SHA followed by `export VPS_SYNC_IMAGE=...:latest`, and also supplies an inherited `latest`. Its fake Docker uses `set -eu` and requires the exact validated SHA. Before the repair, `run-sync.sh` removed the variable and the fake boundary failed.

### GREEN

`run-sync.sh` now executes Compose with `VPS_SYNC_IMAGE="$image"` explicitly assigned after the strict SHA check. This shell value takes precedence over both the inherited value and every `.env` declaration, so Compose cannot interpolate another image during its second parse.

```text
$ node --test scripts/validate-vps-compose.test.mjs
pass 8, fail 0

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

The VPS README also now shows the local `deploy/vps/run-sync.sh shadow` invocation and retains the Task 9.3 fail-closed CLI-composition boundary.

### Commit and hosted CI

- Repair commit: `49adfbaf2de363810e72945df2aba464a18d7c0a` (`fix(vps-sync): pin validated image for Compose`), pushed to `codex/vps-task-7-2`.
- GitHub Actions run: [34670886293](https://github.com/Skyline-Gazer/AiringCal/actions/runs/34670886293) was `validate` in progress when checked. Its dependent `vps-sync-image` job had not started; this report does not claim a hosted Compose result before that job completes.
- Local `docker` and `flock` remain unavailable, so no local Compose rendering or container execution was attempted.
