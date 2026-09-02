import assert from 'node:assert/strict'
import test from 'node:test'
import { transformCalendar } from '@airing-cal/domain'
import { assembleFullFetch as assembleSharedFullFetch } from '@airing-cal/bgm-api'
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
  assert.deepEqual(result.observedUsers, ['alice'])
  assert.deepEqual(result.collections, [{ user_id: 'alice', collection: entry }])
  assert.deepEqual(result.calendar, calendar)
  assert.equal(result.observedAt, 123)
})

test('sync-worker compatibility boundary re-exports the shared complete-fetch implementation', () => {
  assert.equal(assembleFullFetch, assembleSharedFullFetch)
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
  assert.deepEqual(result.observedUsers, ['alice', 'bob'])
})

test('assembleFullFetch records a complete empty user as observed deletion evidence', () => {
  const result = assembleFullFetch(
    [{ user_id: 'empty', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    [],
    123,
  )
  assert.deepEqual(result.collections, [])
  assert.deepEqual(result.observedUsers, ['empty'])
})

test('assembleFullFetch rejects duplicate user groups', () => {
  assert.throws(() => assembleFullFetch([
    { user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 },
    { user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 },
  ], [], 123), /duplicate collection user/i)
})

test('assembleFullFetch preserves optional-field absence on the OpenAPI-compatible minimal calendar item', () => {
  const minimal = [{
    weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
    items: [{ id: 1, type: 2 }],
  }]
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    minimal,
    123,
  )

  assert.deepEqual(result.calendar[0]?.items[0], { id: 1, type: 2 })
})

test('assembleFullFetch allowlists checked-in legacy subjects and maps root rank', () => {
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: [{
        id: 12,
        url: 'https://bgm.tv/subject/12',
        type: 2,
        name: 'A',
        name_cn: 'A CN',
        summary: 'summary',
        air_date: '2026-01-01',
        air_weekday: 1,
        eps: 12,
        eps_count: 13,
        images: { common: 'common' },
        rating: { total: 2289, score: 7.6, count: { 10: 130 } },
        rank: 573,
        collection: { wish: 1 },
        opaque: 'must not escape',
      }],
    }],
    123,
  )

  assert.deepEqual(result.calendar[0]?.items[0], {
    id: 12,
    type: 2,
    name: 'A',
    name_cn: 'A CN',
    summary: 'summary',
    date: '2026-01-01',
    eps: 12,
    eps_count: 13,
    images: { common: 'common' },
    rating: { score: 7.6, rank: 573, total: 2289 },
  })
  assert.equal(transformCalendar(result.calendar)[0]?.items[0]?.rating?.rank, 573)
})

test('assembleFullFetch preserves nested rating presence including explicit zero', () => {
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: [
        { id: 12, type: 2, rating: { score: 9 } },
        { id: 13, type: 2, rating: { score: 0, rank: 0, total: 0 } },
      ],
    }],
    123,
  )

  assert.deepEqual(result.calendar[0]!.items[0]!.rating, { score: 9 })
  assert.deepEqual(result.calendar[0]!.items[1]!.rating, { score: 0, rank: 0, total: 0 })
})

test('assembleFullFetch preserves total-only rating while legacy transform omits the partial shape', () => {
  const result = assembleFullFetch(
    [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }],
    [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: [{ id: 12, type: 2, rating: { total: 1 } }],
    }],
    123,
  )

  assert.deepEqual(result.calendar[0]!.items[0]!.rating, { total: 1 })
  assert.equal(transformCalendar(result.calendar)[0]?.items[0]?.rating, undefined)
})

test('assembleFullFetch reuses the supplied stable workflow observation', () => {
  const input = [{ user_id: 'alice', pages: [{ offset: 0, total: 0, data: [] }], pageLimit: 50 }]
  assert.equal(assembleFullFetch(input, [], 456).observedAt, 456)
  assert.equal(assembleFullFetch(input, [], 456).observedAt, 456)
})
