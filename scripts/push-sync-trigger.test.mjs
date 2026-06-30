import assert from 'node:assert/strict'
import test from 'node:test'

import { syncSnapshotReady } from './push-sync-trigger.mjs'

test('sync trigger readiness requires a non-empty snapshot summary', () => {
  assert.equal(syncSnapshotReady({ _total: 1 }), true)
  assert.equal(syncSnapshotReady({ _total: 0 }), false)
  assert.equal(syncSnapshotReady(null), false)
  assert.equal(syncSnapshotReady({ watching: 1 }), false)
})
