import assert from 'node:assert/strict'
import test from 'node:test'

import { calendarSubjectIds, syncSnapshotReady, syncTriggerReady } from './push-sync-trigger.mjs'

test('sync trigger readiness requires a non-empty snapshot summary', () => {
  assert.equal(syncSnapshotReady({ _total: 1 }), true)
  assert.equal(syncSnapshotReady({ _total: 0 }), false)
  assert.equal(syncSnapshotReady(null), false)
  assert.equal(syncSnapshotReady({ watching: 1 }), false)
})

test('calendarSubjectIds extracts ids from raw and transformed calendar snapshots', () => {
  assert.deepEqual(calendarSubjectIds([
    { items: [{ id: 23080 }, { subject_id: 456080 }, { id: 'bad' }] },
    { items: null },
  ]), [23080, 456080])
})

test('sync trigger readiness requires calendar subjects to have observable common image status', () => {
  const summary = { _total: 1 }
  const calendar = [{ items: [{ id: 23080 }, { id: 456080 }] }]
  const statuses = new Map([
    [23080, { common: { status: 'cached' } }],
    [456080, { common: { status: 'queued' } }],
  ])

  assert.equal(syncTriggerReady(summary, calendar, statuses), true)
  assert.equal(syncTriggerReady(summary, calendar, new Map([[23080, { common: { status: 'cached' } }]])), false)
  assert.equal(syncTriggerReady(summary, calendar, new Map([
    [23080, { common: { status: 'cached' } }],
    [456080, { common: { status: 'pending_next_cron' } }],
  ])), false)
  assert.equal(syncTriggerReady({ _total: 0 }, calendar, statuses), false)
  assert.equal(syncTriggerReady(summary, [], statuses), false)
})
