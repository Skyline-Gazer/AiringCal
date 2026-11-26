import assert from 'node:assert/strict'
import test from 'node:test'
import { exitCode } from './contracts.ts'
import { resolveSyncBuilderKind, runSync } from './sync/run.ts'

test('sync exits 0 when user config is absent and exitCode maps statuses', async () => {
  const summary = await runSync({})
  assert.equal(summary.job, 'airingcal-sync')
  assert.equal(summary.status, 'skipped')
  assert.equal(exitCode(summary), 0)
  assert.equal(exitCode({ job: 'airingcal-sync', status: 'success', message: 'ok' }), 0)
  assert.equal(exitCode({ job: 'airingcal-sync', status: 'failed', message: 'failed' }), 1)
})

test('runSync rejects retired legacy-d1 builder and defaults to portable', async () => {
  assert.equal(resolveSyncBuilderKind({}), 'portable')
  assert.equal(resolveSyncBuilderKind({ AIRINGCAL_BUILDER: 'portable' }), 'portable')
  assert.equal(resolveSyncBuilderKind({ AIRINGCAL_BUILDER: 'legacy-d1' }), 'rejected')
  const rejected = await runSync({ AIRINGCAL_BUILDER: 'legacy-d1' })
  assert.equal(rejected.status, 'failed')
  assert.match(rejected.message, /retired/)
})
