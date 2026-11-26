import assert from 'node:assert/strict'
import test from 'node:test'
import { openBuilderDatabase } from './migrate.ts'
import { SyncRunStore } from './sync-runs.ts'

test('sync run store records incremental lifecycle', () => {
  const db = openBuilderDatabase(':memory:')
  const runs = new SyncRunStore(db)
  runs.startRun('run-1', 'incremental', 100)
  runs.finishRun('run-1', 'succeeded', '{"items":1}', 200)
  const latest = runs.latestRun()
  assert.equal(latest?.run_id, 'run-1')
  assert.equal(latest?.status, 'succeeded')
  assert.equal(latest?.finished_at_unix, 200)
})

test('latestSucceededRun filters by mode', () => {
  const db = openBuilderDatabase(':memory:')
  const runs = new SyncRunStore(db)
  runs.startRun('inc-1', 'incremental', 10)
  runs.finishRun('inc-1', 'succeeded', null, 20)
  runs.startRun('full-1', 'full', 30)
  runs.finishRun('full-1', 'succeeded', null, 40)
  runs.startRun('inc-2', 'incremental', 50)
  runs.finishRun('inc-2', 'failed', null, 60)
  assert.equal(runs.latestSucceededRun('full')?.run_id, 'full-1')
  assert.equal(runs.latestSucceededRun()?.run_id, 'full-1')
})

test('finishRun rejects unknown or already finished runs', () => {
  const db = openBuilderDatabase(':memory:')
  const runs = new SyncRunStore(db)
  assert.throws(() => runs.finishRun('missing', 'failed', null), /not running/)
  runs.startRun('run-2', 'full', 1)
  runs.finishRun('run-2', 'failed', '{"error":"x"}', 2)
  assert.throws(() => runs.finishRun('run-2', 'succeeded', null), /not running/)
})
