import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from './full-fetch-boundary.ts'

const entry = {
  subject_id: 1,
  subject_type: 2,
  rate: 0,
  type: 3,
  comment: '',
  tags: [],
  ep_status: 0,
  vol_status: 0,
  updated_at: '2026-07-20T00:00:00Z',
  private: false,
}

test('assembleFullFetch marks input complete only with every collection page and calendar', () => {
  const result = assembleFullFetch(
    [{ data: [entry], expectedTotal: 1 }],
    [],
  )

  assert.equal(result.complete, true)
  assert.equal(result.collections.length, 1)
  assert.deepEqual(result.calendar, [])
})

test('assembleFullFetch rejects a missing collection page instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ data: null, expectedTotal: 1 }], []),
    /incomplete collection fetch/i,
  )
})

test('assembleFullFetch rejects a missing calendar instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ data: [], expectedTotal: 0 }], null),
    /incomplete calendar fetch/i,
  )
})

test('assembleFullFetch rejects collection counts inconsistent with upstream totals', () => {
  assert.throws(
    () => assembleFullFetch([{ data: [entry], expectedTotal: 2 }], []),
    /incomplete collection fetch/i,
  )
})
