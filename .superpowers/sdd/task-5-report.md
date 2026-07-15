# Task 5 Report

## Status

PASS — compare authentication failures now stop before collection reads and return a stable, token-safe error contract.

## TDD evidence

- RED: domain tests reported missing rejections for source, target, and dual-account `getMe` failures.
- RED: sync-worker returned HTTP 200 for 401, 403, network, 429, and 503 authentication-stage failures.
- GREEN: domain preserves the original authentication error and performs no collection reads; sync-worker classifies only 401/403 as `AUTHENTICATION_FAILED`.

## Implementation

- `compareAccounts` uses fail-fast account lookup and propagates the original error object to its caller.
- A source, target, or dual-account authentication failure prevents both collection fetches.
- The sync-worker compare boundary returns the original 401/403 status with stable code `AUTHENTICATION_FAILED` and public message `Authentication failed`.
- Network, rate-limit, and 5xx failures retain the existing HTTP 500 `REQUEST_FAILED` contract.
- Public responses contain no source or target token.
- README documents the compare authentication contract.

## Verification

- `CI=true pnpm -F @airing-cal/domain test` — PASS (25/25)
- `CI=true pnpm -F @airing-cal/domain typecheck` — PASS
- `CI=true pnpm -F @airing-cal/sync-worker test` — PASS (37/37)
- `CI=true pnpm -F @airing-cal/sync-worker typecheck` — PASS
- `pnpm -F @airing-cal/sync-worker build:check` — PASS
- `CI=true pnpm -F @airing-cal/worker-common test` — PASS (12/12)
- `CI=true pnpm -F @airing-cal/worker-common typecheck` — PASS
- `git diff --check` — PASS

## Concerns

- None. Coordinator-owned task and progress files were not modified or staged.

## Review fix: collection-stage authentication

- RED: added source-side 401, target-side 403, and dual-account collection-stage tests. Domain reported missing rejections; sync-worker returned HTTP 200 instead of 401/403.
- Root cause: collection failures were passed through `Promise.allSettled`; `fetchAllCollections` wrapped the original HTTP error in `Error.cause`, then `unwrapCollections` converted the rejection into an empty/partial result.
- GREEN: before either collection result is unwrapped, domain now finds only a real `Error` whose direct or causal `status` is exactly 401/403 and rethrows that original authentication error.
- Sync mapping accepts the same strict, platform-independent error shape and returns stable `AUTHENTICATION_FAILED`; token-safe public errors are unchanged.
- Non-authentication network, 429, and 5xx failures do not match the strict classifier and retain their existing generic/partial semantics.
- Final verification: domain test 27/27 + typecheck; sync-worker test 39/39 + typecheck + build:check; worker-common test 12/12 + typecheck; all passed.
