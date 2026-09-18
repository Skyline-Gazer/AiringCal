# VPS data-plane build verification

Date: 2026-09-18 (Asia/Shanghai)
Change: `migrate-data-plane-to-vps`
Base: `2cabe20` (`docs(vps-sync): check off documentation sync`)

## Result

The repository and static delivery gates pass locally. Task 9.3 adds guarded,
injectable migration operations and evidence templates; they were exercised
only against fake ports and dry-run inputs. PostgreSQL service tests, container
build/runtime checks, GHCR registry checks, network checks, and production
shadow/restore/cutover were not claimed as passed because the current
environment has no Docker CLI or disposable PostgreSQL service.

## Fresh command evidence

| Gate | Command | Result |
| --- | --- | --- |
| Full repository tests | `CI=true pnpm test` | exit 0; workspace tests and `scripts/*.test.mjs` passed, 0 failures |
| Full typecheck | `CI=true pnpm typecheck` | exit 0; all 10 checked workspace packages passed |
| Full build check | `CI=true pnpm build:check` | exit 0; all worker dry-run/type checks and VPS typecheck passed |
| VPS package wrapper | `CI=true pnpm -F @airing-cal/vps-sync test` | exit 1 because `tsx` could not create its IPC pipe (`listen EPERM`) in the sandbox |
| VPS native fallback | `node --import tsx/esm --test src/**/*.test.ts` from `apps/vps-sync` | exit 0; 162 tests, 155 passed, 7 PostgreSQL integration tests skipped |
| PostgreSQL integration selection | `node --import tsx/esm --test src/postgres/migrate.test.ts src/postgres/repositories.test.ts` | exit 0; 7 passed, 7 skipped because `DATABASE_URL`/`VPS_SYNC_TEST_DATABASE=1` were not configured |
| R2 failure-injection suite | `node --import tsx/esm --test apps/vps-sync/src/publication/publish.test.ts apps/read-worker/src/r2-snapshot.test.ts apps/sync-worker/src/r2-publication.test.ts` | exit 0; 90 passed |
| Image/Compose/workflow validators | `node --test scripts/verify-vps-sync-image.test.mjs scripts/validate-vps-compose.test.mjs scripts/validate-vps-image-workflow.test.mjs` | exit 0; 24 passed |
| Validator entrypoints | `node scripts/verify-vps-sync-image.mjs`; `node scripts/validate-vps-compose.mjs`; `node scripts/validate-vps-image-workflow.mjs` | exit 0; static checks passed; image verifier warned that no `VPS_SYNC_IMAGE` was supplied |
| Documentation contract | `node --test scripts/vps-docs.test.mjs` | exit 0; 4 passed |
| OpenSpec | `pnpm exec openspec validate migrate-data-plane-to-vps --strict` | exit 0; change valid |
| Whitespace | `git diff --check` | exit 0 |

## Audit evidence

### Secret scan

Command (tracked files only; the regex covers private-key headers, AWS access-key
prefixes, common token prefixes, and long Bearer values):

```sh
set +e
tracked_files=$(git ls-files | wc -l | tr -d ' ')
git ls-files -z | xargs -0 rg -n --no-heading --color=never --pcre2 \
  '(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{20,})\b|Bearer[[:space:]]+[A-Za-z0-9._-]{32,})' \
  > /tmp/vps-secret-scan.out
rg_exit=$?
match_lines=$(wc -l < /tmp/vps-secret-scan.out | tr -d ' ')
printf 'tracked_files=%s\nrg_exit=%s\nmatch_lines=%s\n' "$tracked_files" "$rg_exit" "$match_lines"
if [ "$rg_exit" -eq 1 ] && [ "$match_lines" -eq 0 ]; then
  printf 'audit_exit=0 (no high-confidence matches)\n'
  exit 0
fi
printf 'audit_exit=1\n'
exit 1
```

Fresh output: `tracked_files=549`, `rg_exit=1` (ripgrep's no-match code),
`match_lines=0`, `audit_exit=0`.

### Compose environment audit

Command (extracts the variable names from the checked-in Compose file and
checks each required name in every operator-facing configuration/document):

```sh
set +e
vars="$(rg -o '\$\{[A-Z][A-Z0-9_]*' deploy/vps/compose.yaml | sed 's/.*{//' | sort -u)"
var_count=$(printf '%s\n' "$vars" | awk 'NF { count++ } END { print count + 0 }')
printf 'compose_contract_vars=%s\n' "$var_count"
audit_exit=0
for file in deploy/vps/.env.example README.md docs/runbook/vps-data-plane.md docs/architecture/vps-data-plane.md; do
  covered=0
  missing=""
  while IFS= read -r var; do
    [ -n "$var" ] || continue
    if rg -q --fixed-strings "$var" "$file"; then
      covered=$((covered + 1))
    else
      missing="$missing $var"
      audit_exit=1
    fi
  done <<EOF
$vars
EOF
  printf '%s covered=%s/%s missing=%s\n' "$file" "$covered" "$var_count" "${missing# }"
done
printf 'audit_exit=%s\n' "$audit_exit"
exit "$audit_exit"
```

Fresh output: `compose_contract_vars=12`; `.env.example`, `README.md`, the
runbook, and the architecture document each covered `12/12`, with no missing
names; `audit_exit=0`.

### CLI/API audit

The CLI command and documentation contract were checked with:

```sh
set +e
contract='Usage: sync [--mode=shadow|live] [--source=scheduled|manual]'
help_output="$(node --import tsx/esm apps/vps-sync/src/cli.ts --help 2>&1)"
help_exit=$?
printf 'cli_help_exit=%s\ncli_help_output=%s\n' "$help_exit" "$help_output"
audit_exit=$help_exit
[ "$help_output" = "$contract" ] && printf 'cli_help_contract=match\n' || audit_exit=1
contract_hits=0
for file in apps/vps-sync/src/cli.ts README.md docs/runbook/vps-data-plane.md docs/architecture/vps-data-plane.md; do
  if rg -Fq "$contract" "$file"; then
    contract_hits=$((contract_hits + 1))
  else
    audit_exit=1
  fi
done
printf 'contract_files=%s/4\naudit_exit=%s\n' "$contract_hits" "$audit_exit"
exit "$audit_exit"
```

Fresh output: `cli_help_exit=0`, the exact usage line, `cli_help_contract=match`,
`contract_files=4/4`, `audit_exit=0`.

The local BGM OpenAPI and client contract were checked with:

```sh
set +e
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs'
const spec = JSON.parse(readFileSync('docs/example/api/bgm-api.json', 'utf8'))
const required = [
  ['GET', '/v0/users/{username}/collections'],
  ['GET', '/v0/subjects/{subject_id}'],
  ['GET', '/calendar'],
  ['PATCH', '/v0/users/-/collections/{subject_id}'],
  ['POST', '/v0/users/-/collections/{subject_id}'],
  ['GET', '/v0/users/-/collections/{subject_id}/episodes'],
  ['PATCH', '/v0/users/-/collections/{subject_id}/episodes'],
]
const missing = required.filter(([method, path]) => !spec.paths[path]?.[method.toLowerCase()])
console.log(`runtime_endpoint_method_pairs=${required.length}`)
console.log(`openapi_paths=${Object.keys(spec.paths).length}`)
console.log(`missing_pairs=${missing.length}`)
if (missing.length) process.exitCode = 1
NODE
spec_exit=$?
node --import tsx/esm --test packages/bgm-api/src/*.test.ts > /tmp/bgm-api-audit-all.out 2>&1
suite_exit=$?
rg '^ℹ (tests|pass|fail|skipped) ' /tmp/bgm-api-audit-all.out | tail -4
printf 'api_spec_audit_exit=%s\napi_contract_suite_exit=%s\n' "$spec_exit" "$suite_exit"
[ "$spec_exit" -eq 0 ] && [ "$suite_exit" -eq 0 ]
```

Fresh output: `runtime_endpoint_method_pairs=7`, `openapi_paths=47`,
`missing_pairs=0`; the BGM client contract suite reported `tests 29`,
`pass 29`, `fail 0`, `skipped 0`; both exit codes were `0`. OAuth helper
endpoints are outside this VPS-facing audit and were not changed by this task.

The docs contract tests, Compose validator, workflow validator, and image
verifier cover the checked-in README/config/API-facing delivery claims.

## Explicitly unexecuted gates

### Task 9.3 operation evidence

- `node --import tsx/esm --test apps/vps-sync/src/operations/migration.test.ts` — exit 0; 8 tests, 8 passed. This includes three fake shadow rounds, field-level JSON-pointer diffs, restore dry-run, cutover approval-token rejection, and verified-manifest-only rollback.
- `node --import tsx/esm --test src/**/*.test.ts` from `apps/vps-sync` — exit 0; 162 tests, 155 passed, 7 PostgreSQL integration tests skipped because no disposable service/credentials were configured.
- `pnpm -F @airing-cal/vps-sync typecheck` and `pnpm -F @airing-cal/vps-sync build:check` — exit 0.
- `CI=true pnpm build:check` — exit 0; workspace checks completed. Wrangler emitted the existing sandbox `EPERM` log-file diagnostics while dry-run builds still completed; no VPS operation connects to a production service.
- CLI help was run for `shadow-compare`, `restore-verify`, `cutover`, and `rollback`; each exited 0 and printed the checked-in command contract. The new parser accepts environment variable names, never database URLs or approval secrets, and missing injected runtime ports fail closed.
- `git diff --check` — exit 0.

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
  explicit follow-up/production gates for Task 9.4 and deployment; Task 9.3
  intentionally provides only the fake/dry-run gate and injected operation
  boundary.
