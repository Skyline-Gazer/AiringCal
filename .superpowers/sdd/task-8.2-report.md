# Task 8.2 verification report

## Scope

- Added a required `workflow_dispatch` boolean `debug` input to the existing
  VPS image workflow.
- Push events keep the production path: full-SHA preflight, production target,
  immutable full-SHA tag, discovery tag, metadata artifact, and production
  summary.
- A manual run with `debug: true` skips every production-only step and builds
  only the Dockerfile `debug` target with the exact
  `${{ github.sha }}-debug` metadata tag.
- Kept the existing verified action commit SHAs and existing GHCR contract;
  no deployment, SSH, GHCR deletion, or production cutover was added.
- Production Compose image validation rejects a full-SHA `-debug` reference and
  explains that the tag is not a production image. The VPS deployment guide
  documents the manual debug path and its production boundary.

## TDD evidence

### RED

Command:

```text
node --test scripts/validate-vps-image-workflow.test.mjs scripts/validate-vps-compose.test.mjs
```

Result: 16 passed, 2 failed as expected. The new failures were the missing
manual debug trigger/build isolation and the missing explicit `debug` wording
for a rejected `<sha>-debug` production reference.

### GREEN

Command:

```text
node --test scripts/validate-vps-image-workflow.test.mjs scripts/validate-vps-compose.test.mjs
```

Result: 18 passed, 0 failed.

Additional gates:

```text
node --test scripts/*.test.mjs
```

Result: 47 passed, 0 failed.

```text
node scripts/validate-vps-image-workflow.mjs
node scripts/validate-vps-compose.mjs
git diff --check
```

Result: workflow validator passed; Compose validator passed with its expected
warning that `VPS_SYNC_IMAGE` was not supplied; whitespace check passed.

Ruby's local YAML parser accepted `.github/workflows/vps-sync-image.yml`.
No Docker or Podman CLI is installed in this environment, so no image build,
push, registry mutation, or container execution was attempted.
