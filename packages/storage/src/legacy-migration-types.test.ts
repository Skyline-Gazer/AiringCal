import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateCleanupCursorKey,
  migrateKvBudgetDailyKey,
  migrateLegacyCursorKey,
  migrateLegacySummaryKey,
  migrateReadModeKey,
  migrateShadowStreakKey,
  publicReadModeKvKey,
} from './legacy-migration-types.ts'

test('migration app_state keys are namespaced and stable', () => {
  assert.equal(migrateLegacyCursorKey(), 'migrate:legacy:cursor')
  assert.equal(migrateLegacySummaryKey(), 'migrate:legacy:summary')
  assert.equal(migrateShadowStreakKey(), 'migrate:shadow:streak')
  assert.equal(migrateReadModeKey(), 'migrate:read-mode')
  assert.equal(migrateKvBudgetDailyKey(), 'migrate:kv-budget-daily')
  assert.equal(migrateKvBudgetDailyKey('2026-07-31'), 'migrate:kv-budget-daily:2026-07-31')
  assert.equal(migrateCleanupCursorKey(), 'migrate:cleanup:cursor')
  assert.equal(publicReadModeKvKey(), 'public:read-mode')
})
