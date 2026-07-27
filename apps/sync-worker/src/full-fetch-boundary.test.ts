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
    [{ pages: [{ offset: 0, total: 1, data: [entry] }], pageLimit: 50 }],
    [],
  )

  assert.equal(result.complete, true)
  assert.equal(result.collections.length, 1)
  assert.deepEqual(result.calendar, [])
})

test('assembleFullFetch rejects a missing collection page instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ pages: [{ offset: 0, total: 1, data: null }], pageLimit: 50 }], []),
    /incomplete collection fetch/i,
  )
})

test('assembleFullFetch rejects a missing calendar instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }], null),
    /incomplete calendar fetch/i,
  )
})

test('assembleFullFetch rejects collection counts inconsistent with upstream totals', () => {
  assert.throws(
    () => assembleFullFetch([{ pages: [{ offset: 0, total: 2, data: [entry] }], pageLimit: 50 }], []),
    /incomplete collection fetch/i,
  )
})

test('assembleFullFetch rejects total drift between pages', () => {
  assert.throws(() => assembleFullFetch([{
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 1, total: 3, data: [{ ...entry, subject_id: 2 }] },
    ],
  }], []), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects duplicate subjects that conceal a missing item', () => {
  assert.throws(() => assembleFullFetch([{
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 1, total: 2, data: [entry] },
    ],
  }], []), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects an offset gap', () => {
  assert.throws(() => assembleFullFetch([{
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 2, total: 2, data: [{ ...entry, subject_id: 2 }] },
    ],
  }], []), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects non-array calendar payloads at runtime', () => {
  assert.throws(
    () => assembleFullFetch([{ pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }], {} as never),
    /incomplete calendar fetch/i,
  )
})
