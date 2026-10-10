import assert from 'node:assert/strict'
import test from 'node:test'
import { JobError } from '../adapters/errors.ts'
import { exportPoll } from './export-poll.ts'

test('exportPoll maps bookmark progress', () => {
  assert.deepEqual(exportPoll({ at_bookmark: 'a' }), { bookmark: 'a' })
})

test('exportPoll accepts https signed_url', () => {
  assert.deepEqual(
    exportPoll({ status: 'complete', result: { signed_url: 'https://export.example/dump.sql?sig=1' } }),
    { url: 'https://export.example/dump.sql?sig=1' },
  )
})

test('exportPoll rejects invalid export responses', () => {
  assert.throws(() => exportPoll({ status: 'error' }), (error: unknown) => error instanceof JobError && error.code === 'D1_EXPORT_FAILED')
  assert.throws(
    () => exportPoll({ status: 'complete', result: { signed_url: 'http://export.invalid/' } }),
    (error: unknown) => error instanceof JobError && error.code === 'D1_EXPORT_INVALID',
  )
})
