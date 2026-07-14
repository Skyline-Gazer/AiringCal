## Task 4 Extra Fix Report

- Commit hash: `4301eec0f064e76de5fc7cc5600cde4ec537abfb`
- Changed files:
  - `packages/worker/src/manage/index.html`
  - `packages/worker/src/manage/index-html.test.mjs`

### RED

- Command:
  - `node --test packages/worker/src/manage/index-html.test.mjs packages/worker/src/manage/security.test.ts`
- Failure summary:
  - The new regression test failed before the fix because a stale OAuth exchange could still replace `pendingOAuth` and launch the next flow.

### GREEN

- Command:
  - `node --test packages/worker/src/manage/index-html.test.mjs packages/worker/src/manage/security.test.ts`
- Pass summary:
  - All 48 tests passed, including the new stale-exchange regression test and the existing security suite.

### Dry-run

- Command:
  - `WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-task4-extra.log ./node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management-task4-extra`
- Result:
  - Passed.
  - Wrangler reported the expected bindings and exited with `--dry-run: exiting now.`

### Self-review

- The fix is minimal: one flow-identity guard before applying exchange results, and one guard before running `nextAction`.
- No new dependency or abstraction was added.
- The regression test exercises a real stale-response race instead of a brittle string match.
- Scope stayed within the allowed manage-page HTML and its test file.

---

## Task 4 Round 4 Extra Fix

### Root cause

- Reviewer 指出的时序问题已复现并确认：`exchangeOAuth()` 在校验 `pendingOAuth === flow` 之前，先调用 `apiFetch('/api/manage/exchange')`。
- 旧实现里 `apiFetch()` 遇到 `401/503` 会立即执行 `handleManageDenied()`，其副作用包括：
  - 显示 gate；
  - 清空 `manageSecret`；
  - 重新锁定 `data-requires-secret` 控件。
- 因为这些副作用发生在 `exchangeOAuth -> apiFetch -> handleManageDenied` 链路上，且早于 `pendingOAuth === flow` 检查，所以旧 flow 的 `401/503` 仍会污染当前新 flow 的 UI 和密码状态。
- 同一时序下，`exchangeOAuth()` 在 `response` 为假值后还会继续 `showManageAuthFailure(target)`，因此旧 flow 还能覆盖当前 OAuth 区域提示文案。

### RED

- 先在 `packages/worker/src/manage/index-html.test.mjs` 补了真实行为回归测试：
  - 旧 `exchange` 正在等待时，再启动新的 `account-a` flow；
  - 让旧响应分别以 `401` 和 `503` 返回；
  - 断言新的 `pendingOAuth` 仍保持当前 flow；
  - 断言 `manageSecret` 不被清空、`manageLocked` 不被重新锁定；
  - 断言 gate 不会被旧响应重新显示；
  - 断言当前 flow 的 OAuth 提示 UI 不被旧响应污染。
- Command:
  - `node --test packages/worker/src/manage/index-html.test.mjs packages/worker/src/manage/security.test.ts`
- Result:
  - RED confirmed.
  - 新测试失败在 `manageSecret` 被提前清空：`'' !== 'top-secret'`。

### GREEN

- 最小修复只改管理页脚本：
  - 给 `apiFetch()` 增加最小且明确的 `deferManageDenied` 控制位；
  - 仅 `exchangeOAuth()` 调 `apiFetch(..., { deferManageDenied: true })` 获取原始 `Response`；
  - `exchangeOAuth()` 先确认 `pendingOAuth === flow`，仅当该 flow 仍是当前 flow 时才处理 `401/503` 的 gate / clear-secret / lock UI 副作用；
  - 其他 `apiFetch()` 调用保持原有 `401/503` 行为不变。
- Command:
  - `node --test packages/worker/src/manage/index-html.test.mjs packages/worker/src/manage/security.test.ts`
- Result:
  - GREEN confirmed.
  - All 49 tests passed.

### Dry-run

- Command:
  - `WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-task4-extra2.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management-task4-extra2 --config packages/worker/wrangler.toml`
- Result:
  - Passed.
  - `wrangler 4.100.0` dry-run completed and exited with `--dry-run: exiting now.`

### Commit

- Commit message:
  - `fix: defer stale OAuth auth failures`
- Commit hash:
  - `3f640e9`

### Self-review

- 修复范围只在允许的两个文件内，未改 plan、OpenSpec、锁文件或其他实现文件。
- stale `200` 的既有行为测试仍保留；新增测试补上 stale `401/503` 缺口。
- 修复点放在根因处：把 `401/503` 的副作用从 `apiFetch` 的过早阶段延后到 `exchangeOAuth` 完成当前-flow 身份确认之后。
- `exchange` 之外的管理 API 仍保留原先统一的 `401/503` 处理，不引入新框架或额外抽象。
