import assert from 'node:assert/strict'
import test from 'node:test'
import { exitCode } from './contracts.ts'
import { runBackup } from './backup/run.ts'
import { runSync } from './sync/run.ts'

test('sync exits 0 when user config is absent', async () => {
  const summary = await runSync({})
  assert.equal(summary.job, 'airingcal-sync')
  assert.equal(summary.status, 'skipped')
  assert.equal(exitCode(summary), 0)
})

test('backup reports failed when cloudflare config is absent', async () => {
  const summary = await runBackup({})
  assert.equal(summary.job, 'airingcal-backup')
  assert.equal(summary.status, 'failed')
  assert.equal(summary.message, 'CONFIG_INVALID')
  assert.equal(exitCode(summary), 1)
})
