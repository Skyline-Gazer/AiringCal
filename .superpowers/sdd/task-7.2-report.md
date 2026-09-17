# Task 7.2 report — SHA-pinned Compose, secrets, tmp, and host cron

## Scope

Implemented only the Task 7.2 brief:

- `deploy/vps/compose.yaml`: one-shot `sync` service with a required full-SHA
  `VPS_SYNC_IMAGE`, non-root user, init process, read-only root, dropped
  capabilities, no ports/restart/privileged/socket, and writable
  `/tmp/airing-cal` tmpfs.
- `deploy/vps/.env.example`: private template for the PostgreSQL, Bangumi, R2,
  Feishu, and immutable image settings.
- `deploy/vps/run-sync.sh`: mode-checked `shadow|live` wrapper with a
  non-blocking host `flock`, `docker compose run --rm`, and fixed scheduled
  source. It never echoes environment values.
- `deploy/vps/README.md`: private env-file setup, validator/config commands,
  shadow-first local invocation, and 04:00 Asia/Shanghai host-cron example.
- `scripts/validate-vps-compose.mjs` and its test: immutable image grammar and
  static Compose/wrapper hardening checks.

No GHCR workflow, debug-image workflow, production cutover, resource cleanup,
or Task 7.3+ work was added.

## Contract verification before writing

The required local checks were attempted first:

| Command | Result |
| --- | --- |
| `docker compose config --help` | exit 127 — Docker CLI is not installed |
| `docker compose run --help` | exit 127 — Docker CLI is not installed |
| `flock --help` | exit 127 — `flock` is not installed on this macOS environment |

Fallback references were the official Docker documentation and util-linux
manual:

- [Compose CLI reference](https://docs.docker.com/reference/cli/docker/compose/)
  verifies `--env-file`, `-f/--file`, and `config`.
- [`docker compose run`](https://docs.docker.com/reference/cli/docker/compose/run/)
  verifies the one-shot form and `--rm`.
- [Compose service attributes](https://docs.docker.com/reference/compose-file/services/)
  verifies `init`, `read_only`, `user`, `cap_drop`, and `tmpfs` including
  `mode` options.
- [Compose variable interpolation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)
  verifies `${VAR:?error}` required values and `${VAR:-default}` optional
  values.
- [`flock(1)`](https://www.man7.org/linux/man-pages/man1/flock.1.html)
  verifies `-n/--nonblocking` and file-descriptor locking.

Actual image rendering/build/run was not claimed because Docker is unavailable.
On a Linux Docker host, rerun the two help commands, `docker compose ... config`,
and a real shadow run before operational use.

## TDD evidence

1. RED: `node --test scripts/validate-vps-compose.test.mjs` failed with
   `ERR_MODULE_NOT_FOUND` because the validator did not exist.
2. GREEN: the same command passes 6/6 tests.
3. Additional checks:
   - `VPS_SYNC_IMAGE=ghcr.io/skyline-gazer/airing-cal-sync:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa node scripts/validate-vps-compose.mjs` exits 0.
   - `node scripts/validate-vps-compose.mjs` exits 0 with an explicit warning
     when no runtime image is supplied; static checks still run.
   - `sh -n deploy/vps/run-sync.sh` exits 0.
   - `git diff --check` exits 0.

## Known boundary

The current repository intentionally has no complete PostgreSQL/Bangumi/R2
runtime composition in the executable CLI; Task 6.2 made the process-facing
entrypoint fail closed without injected runtime ports. This task only supplies
the deployment contract and does not pretend that `run-sync.sh` is a completed
production sync composition.
