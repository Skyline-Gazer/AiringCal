import assert from 'node:assert/strict'
import test from 'node:test'

import { syncSnapshotReady, syncTriggerReady } from './push-sync-trigger.mjs'

test('sync trigger readiness requires a non-empty snapshot summary', () => {
  assert.equal(syncSnapshotReady({ _total: 1 }), true)
  assert.equal(syncSnapshotReady({ _total: 0 }), false)
  assert.equal(syncSnapshotReady(null), false)
  assert.equal(syncSnapshotReady({ watching: 1 }), false)
})

test('sync trigger readiness requires both snapshot and image cache status', () => {
  assert.equal(syncTriggerReady({ _total: 1 }, [{ name: 'image:status:23080' }]), true)
  assert.equal(syncTriggerReady({ _total: 1 }, []), false)
  assert.equal(syncTriggerReady({ _total: 0 }, [{ name: 'image:status:23080' }]), false)
  assert.equal(syncTriggerReady(null, [{ name: 'image:status:23080' }]), false)
})
