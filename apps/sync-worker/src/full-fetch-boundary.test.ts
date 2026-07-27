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

const calendar = [{
  weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
  items: [{
    id: 1,
    type: 2,
    name: 'A',
    name_cn: 'A CN',
    summary: '',
    nsfw: false,
    date: '2026-01-01',
    eps: 12,
    images: { large: '', common: '', medium: '', small: '', grid: '' },
    rating: { score: 0, rank: 0, total: 0 },
  }],
}]

test('assembleFullFetch marks input complete only with every collection page and calendar', () => {
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 1, data: [entry] }], pageLimit: 50 }],
    calendar,
    123,
  )

  assert.equal(result.complete, true)
  assert.deepEqual(result.collections, [{ user_id: 'alice', collection: entry }])
  assert.deepEqual(result.calendar, calendar)
  assert.equal(result.observedAt, 123)
})

test('assembleFullFetch rejects a missing collection page instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ user_id: 'alice', pages: [{ offset: 0, total: 1, data: null }], pageLimit: 50 }], [], 123),
    /incomplete collection fetch/i,
  )
})

test('assembleFullFetch rejects a missing calendar instead of exposing partial deletion input', () => {
  assert.throws(
    () => assembleFullFetch([{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }], null, 123),
    /incomplete calendar fetch/i,
  )
})

test('assembleFullFetch rejects collection counts inconsistent with upstream totals', () => {
  assert.throws(
    () => assembleFullFetch([{ user_id: 'alice', pages: [{ offset: 0, total: 2, data: [entry] }], pageLimit: 50 }], [], 123),
    /incomplete collection fetch/i,
  )
})

test('assembleFullFetch rejects total drift between pages', () => {
  assert.throws(() => assembleFullFetch([{
    user_id: 'alice',
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 1, total: 3, data: [{ ...entry, subject_id: 2 }] },
    ],
  }], [], 123), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects duplicate subjects that conceal a missing item', () => {
  assert.throws(() => assembleFullFetch([{
    user_id: 'alice',
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 1, total: 2, data: [entry] },
    ],
  }], [], 123), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects an offset gap', () => {
  assert.throws(() => assembleFullFetch([{
    user_id: 'alice',
    pageLimit: 1,
    pages: [
      { offset: 0, total: 2, data: [entry] },
      { offset: 2, total: 2, data: [{ ...entry, subject_id: 2 }] },
    ],
  }], [], 123), /incomplete collection fetch/i)
})

test('assembleFullFetch rejects non-array calendar payloads at runtime', () => {
  assert.throws(
    () => assembleFullFetch([{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }], {} as never, 123),
    /incomplete calendar fetch/i,
  )
})

for (const invalid of [
  [null],
  [{}],
  [{ weekday: calendar[0]!.weekday, items: null }],
  [{ weekday: { ...calendar[0]!.weekday, id: '1' }, items: [] }],
  [{ weekday: calendar[0]!.weekday, items: [{}] }],
]) {
  test(`assembleFullFetch rejects malformed calendar ${JSON.stringify(invalid)}`, () => {
    assert.throws(
      () => assembleFullFetch(
        [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
        invalid,
        123,
      ),
      /incomplete calendar fetch/i,
    )
  })
}

test('assembleFullFetch retains user identity for the same subject across users', () => {
  const result = assembleFullFetch([
    { user_id: 'alice', pages: [{ offset: 0, total: 1, data: [entry] }], pageLimit: 50 },
    { user_id: 'bob', pages: [{ offset: 0, total: 1, data: [entry] }], pageLimit: 50 },
  ], [], 123)

  assert.deepEqual(result.collections.map(({ user_id }) => user_id), ['alice', 'bob'])
})

test('assembleFullFetch rejects duplicate user groups', () => {
  assert.throws(() => assembleFullFetch([
    { user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 },
    { user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 },
  ], [], 123), /duplicate collection user/i)
})

test('assembleFullFetch accepts the OpenAPI-compatible minimal calendar item', () => {
  const minimal = [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{ id: 1, type: 2, name: 'A', name_cn: '', summary: '', date: '' }],
  }]
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    minimal,
    123,
  )

  assert.equal(result.calendar[0]?.items[0]?.eps, 0)
  assert.deepEqual(result.calendar[0]?.items[0]?.images, {
    large: '', common: '', medium: '', small: '', grid: '',
  })
})

test('assembleFullFetch reuses the supplied stable workflow observation', () => {
  const input = [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }]
  assert.equal(assembleFullFetch(input, [], 456).observedAt, 456)
  assert.equal(assembleFullFetch(input, [], 456).observedAt, 456)
})
