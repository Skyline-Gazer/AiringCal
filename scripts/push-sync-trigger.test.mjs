import assert from 'node:assert/strict'
import test from 'node:test'

import {
  calendarSubjectIds,
  ensureSyncConsumer,
  syncConsumerNeedsUpdate,
  syncMetaFresh,
  syncSnapshotReady,
  syncTriggerReady,
} from './push-sync-trigger.mjs'

test('sync trigger readiness requires a non-empty snapshot summary', () => {
  assert.equal(syncSnapshotReady({ _total: 1 }), true)
  assert.equal(syncSnapshotReady({ _total: 0 }), false)
  assert.equal(syncSnapshotReady(null), false)
  assert.equal(syncSnapshotReady({ watching: 1 }), false)
})

test('sync trigger readiness requires sync metadata written after the trigger was queued', () => {
  const sinceMs = Date.UTC(2026, 6, 8, 4, 0, 0) + 900

  assert.equal(syncMetaFresh({ synced_at: Math.floor(sinceMs / 1000) }, sinceMs), true)
  assert.equal(syncMetaFresh({ synced_at: Math.floor(sinceMs / 1000) - 1 }, sinceMs), false)
  assert.equal(syncMetaFresh({ synced_at: 'bad' }, sinceMs), false)
  assert.equal(syncMetaFresh(null, sinceMs), false)
})

test('calendarSubjectIds extracts ids from raw and transformed calendar snapshots', () => {
  assert.deepEqual(calendarSubjectIds([
    { items: [{ id: 23080 }, { subject_id: 456080 }, { id: 'bad' }] },
    { items: null },
  ]), [23080, 456080])
})

test('sync trigger readiness requires calendar subjects to have observable common image status', () => {
  const sinceMs = Date.UTC(2026, 6, 8, 4, 0, 0)
  const meta = { synced_at: Math.floor(sinceMs / 1000) }
  const summary = { _total: 1 }
  const calendar = [{ items: [{ id: 23080, total_episodes: 12 }, { id: 456080, eps: 24 }] }]
  const statuses = new Map([
    [23080, { common: { status: 'cached' } }],
    [456080, { common: { status: 'queued' } }],
  ])

  assert.equal(syncTriggerReady(summary, calendar, statuses, meta, sinceMs), true)
  assert.equal(syncTriggerReady(summary, calendar, statuses, { synced_at: Math.floor(sinceMs / 1000) - 1 }, sinceMs), false)
  assert.equal(syncTriggerReady(summary, calendar, new Map([[23080, { common: { status: 'cached' } }]]), meta, sinceMs), false)
  assert.equal(syncTriggerReady(summary, calendar, new Map([
    [23080, { common: { status: 'cached' } }],
    [456080, { common: { status: 'pending_next_cron' } }],
  ]), meta, sinceMs), false)
  assert.equal(syncTriggerReady({ _total: 0 }, calendar, statuses, meta, sinceMs), false)
  assert.equal(syncTriggerReady(summary, [], statuses, meta, sinceMs), false)
})

test('sync trigger readiness does not require raw calendar snapshots to include episode totals', () => {
  const sinceMs = Date.UTC(2026, 6, 8, 4, 0, 0)
  const meta = { synced_at: Math.floor(sinceMs / 1000) }
  const summary = { _total: 1 }
  const statuses = new Map([
    [23080, { common: { status: 'cached' } }],
    [456080, { common: { status: 'cached' } }],
  ])

  assert.equal(syncTriggerReady(summary, [{ items: [{ id: 23080 }, { id: 456080 }] }], statuses, meta, sinceMs), true)
  assert.equal(syncTriggerReady(summary, [{ items: [{ id: 23080, total_episodes: 12 }, { id: 456080 }] }], statuses, meta, sinceMs), true)
  assert.equal(syncTriggerReady(summary, [{ items: [{ id: 23080, eps_count: 12 }, { id: 456080, totalEpisodes: 24 }] }], statuses, meta, sinceMs), true)
})

test('sync trigger repairs missing queue worker consumer before pushing messages', async () => {
  const calls = []
  await ensureSyncConsumer('queue-1', async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (path === '/accounts/account-1/queues/queue-1/consumers') return { result: [] }
    return { result: { consumer_id: 'consumer-1' } }
  }, 'account-1', () => {})

  assert.deepEqual(calls, [
    { path: '/accounts/account-1/queues/queue-1/consumers', method: 'GET', body: null },
    {
      path: '/accounts/account-1/queues/queue-1/consumers',
      method: 'POST',
      body: {
        script_name: 'airing-cal-sync',
        type: 'worker',
        settings: {
          batch_size: 1,
          max_wait_time_ms: 5000,
          max_retries: 3,
        },
      },
    },
  ])
})

test('sync trigger updates stale queue worker consumer settings before pushing messages', async () => {
  const calls = []
  const staleConsumer = {
    consumer_id: 'consumer-1',
    script_name: 'airing-cal-sync',
    type: 'worker',
    settings: { batch_size: 10, max_wait_time_ms: 10000, max_retries: 1 },
  }

  assert.equal(syncConsumerNeedsUpdate(staleConsumer), true)
  await ensureSyncConsumer('queue-1', async (path, init = {}) => {
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null })
    if (path === '/accounts/account-1/queues/queue-1/consumers') return { result: [staleConsumer] }
    return { result: staleConsumer }
  }, 'account-1', () => {})

  assert.deepEqual(calls.map((call) => [call.method, call.path]), [
    ['GET', '/accounts/account-1/queues/queue-1/consumers'],
    ['PUT', '/accounts/account-1/queues/queue-1/consumers/consumer-1'],
  ])
  assert.equal(calls[1].body.settings.batch_size, 1)
  assert.equal(calls[1].body.settings.max_wait_time_ms, 5000)
  assert.equal(calls[1].body.settings.max_retries, 3)
})

test('sync trigger fails fast when another queue consumer owns the trigger queue', async () => {
  await assert.rejects(
    ensureSyncConsumer('queue-1', async () => ({
      result: [{ consumer_id: 'consumer-2', script_name: 'other-worker', type: 'worker' }],
    }), 'account-1'),
    /already has unexpected consumers/,
  )
})
