# Task 4 Report

## Status

Implemented bgm.tv episode collection pagination and conservative PATCH batching with structured partial-failure evidence.

## TDD evidence

- RED: pagination test observed offsets `[0]` instead of `[0, 1000]`.
- RED: incomplete pagination returned success instead of rejecting an empty page.
- RED: 201 changed episode IDs were sent as `[201]` instead of `[100, 100, 1]`.
- RED: a configured second-batch failure did not reject because no second batch existed.
- RED: `executeSync` reduced partial failure evidence to a message-only error result.
- GREEN: all new assertions pass after the minimal implementation.

## Implementation

- `getSubjectEpisodeCollections` requests `limit=1000` pages until accumulated data reaches `total`.
- `BgmPaginationError` reports stable code `EPISODE_PAGINATION_EMPTY_PAGE` for an empty page before `total`.
- Episode PATCH requests are sliced into batches of at most 100 IDs.
- `BgmEpisodePatchError` retains the original cause and exposes `code`, successful ID count, and failed batch index/IDs.
- Domain `executeSync` detects the stable error shape without importing bgm-api and preserves structured evidence in its public result.
- Error messages contain subject/batch metadata but no access tokens.

## Verification

- bgm-api complete suite: 19 passed.
- domain complete suite: 15 passed.
- `@airing-cal/bgm-api` typecheck: passed.
- `@airing-cal/domain` typecheck: passed.
- `git diff --check`: passed.

Node 26 retained timeout handles when running the package's bare `tsx --test`; complete suites were therefore run with the locally verified Node test option `--test-force-exit` and explicit test files where needed.

## Review remediation

- RED: total drift, accumulated rows beyond the first total, duplicate episode IDs, and non-empty pages without unique progress were accepted or failed without the stable pagination code.
- RED: malformed partial evidence was accepted for non-`Error` objects, `NaN`/negative/unsafe counters, and zero/unsafe episode IDs.
- RED: invalid first-page totals (`NaN` and values beyond the safe integer range) were not rejected with the consistency code.
- GREEN: the first total is fixed and validated as a non-negative safe integer; later drift, overfill, duplicate IDs, and stalled unique progress reject with `EPISODE_PAGINATION_INCONSISTENT`, while the existing empty-page code and normal 1001-item behavior remain intact.
- GREEN: partial evidence now requires a real `Error`, exact code, non-negative safe `succeeded`/batch index, and positive safe episode IDs.
- Coverage: a multi-type scenario proves `succeeded` and failed batch `index` remain global across type buckets (`101` successes, failed batch index `2`).

## Review verification

- `CI=true pnpm -F @airing-cal/bgm-api test`: 27 passed.
- `CI=true pnpm -F @airing-cal/domain test`: 23 passed.
- Both package typechecks passed.
- `git diff --check` passed.
