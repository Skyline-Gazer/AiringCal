import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, type BgmCalendarItem, type BgmCollection } from './bgm-client.ts'
import { assembleFullFetch, type CollectionFetchGroup, type EpisodeProgressSubject } from './full-fetch-boundary.ts'

function calendarDay(items: unknown[]): unknown {
  return [
    {
      weekday: { en: 'Mon', cn: '星期一', ja: '月耀日', id: 1 },
      items,
    },
  ]
}

function baseItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 501,
    type: 2,
    name: 'Test',
    name_cn: '测试',
    summary: '',
    date: '2026-10-06',
    eps: 12,
    images: {
      large: 'https://example.test/l.jpg',
      common: 'https://example.test/c.jpg',
      medium: 'https://example.test/m.jpg',
      small: 'https://example.test/s.jpg',
      grid: 'https://example.test/g.jpg',
    },
    ...overrides,
  }
}

test('assembleFullFetch accepts null optional calendar fields as absent', () => {
  const result = assembleFullFetch(
    [],
    calendarDay([
      baseItem({ images: null, date: null, name: null, name_cn: null, summary: null }),
    ]),
    1_700_000_000,
  )
  const item = result.calendar[0]?.items[0] as BgmCalendarItem['items'][number] & Record<string, unknown>
  assert.equal(item.id, 501)
  assert.equal(item.images, undefined)
  assert.equal(item.date, undefined)
  assert.equal(item.name, undefined)
  assert.equal(item.name_cn, undefined)
  assert.equal(item.summary, undefined)
})

test('assembleFullFetch still rejects wrong-typed optional calendar fields', () => {
  assert.throws(
    () => assembleFullFetch([], calendarDay([baseItem({ images: 'not-an-object' })]), 1_700_000_000),
    /Incomplete calendar fetch/,
  )
})

test('BgmClient remains the base class used for strict client checks', () => {
  const client = new BgmClient(undefined, { maxGetRetries: 0 })
  assert.equal(client.maxGetRetries, 0)
})

// ---------------------------------------------------------------------------
// #195 P3: episode progress carried by the complete-fetch boundary
// ---------------------------------------------------------------------------

const groupOf = (userId: string, subjectIds: number[]): CollectionFetchGroup => ({
  user_id: userId,
  pageLimit: 50,
  pages: [{
    offset: 0,
    total: subjectIds.length,
    data: subjectIds.map((subject_id) => ({
      subject_id,
      subject_type: 2,
      rate: 0,
      type: 3,
      tags: [],
      ep_status: 1,
      vol_status: 0,
      updated_at: '2026-01-01T00:00:00Z',
      private: false,
    })) as unknown as BgmCollection[],
  }],
})

test('assembleFullFetch carries validated episode progress (#195)', () => {
  const groups = [groupOf('u1', [10, 11])]
  const progress = [
    {
      user_id: 'u1',
      subject_id: 10,
      observed_at: 1767225600,
      episodes: [
        { episode_id: 1, collection_type: 2, episode_type: 0, sort: 1, ep: 1, updated_at: 10 },
        { episode_id: 2, collection_type: 0, episode_type: 1, sort: 2, ep: 0, airdate: '2026-02-01', updated_at: 11 },
      ],
    },
  ] as EpisodeProgressSubject[]
  const out = assembleFullFetch(groups, [], 1767225600, progress)
  assert.equal(out.episodeProgress.length, 1)
  assert.equal(out.episodeProgress[0].episodes.length, 2)
  assert.equal(out.episodeProgress[0].episodes[1].episode_type, 1, 'SP type kept')
  const legacy = assembleFullFetch(groups, [], 1767225600)
  assert.deepEqual(legacy.episodeProgress, [], 'omitted groups keep an empty field')
})

test('assembleFullFetch rejects episode progress that cannot be tied to fetched collections (#195)', () => {
  const groups = [groupOf('u1', [10])]
  const base = { user_id: 'u1', subject_id: 10, observed_at: 1767225600, episodes: [{ episode_id: 1, collection_type: 2, updated_at: 5 }] } as EpisodeProgressSubject
  assert.doesNotThrow(() => assembleFullFetch(groups, [], 1767225600, [base]))
  assert.throws(
    () => assembleFullFetch(groups, [], 1767225600, [{ ...base, subject_id: 999 }]),
    /episode/i,
    'subject must exist in the fetched collections',
  )
  assert.throws(
    () => assembleFullFetch(groups, [], 1767225600, [{ ...base, user_id: 'ghost' }]),
    /episode|user/i,
  )
  assert.throws(
    () => assembleFullFetch(groups, [], 1767225600, [
      base,
      { ...base, episodes: [{ episode_id: 1, collection_type: 9, updated_at: 5 }] },
    ].map((entry, index) => (index === 1 ? { ...entry, subject_id: 10 } : entry)) as EpisodeProgressSubject[]),
    /collection_type|episode/i,
    'invalid collection state rejected',
  )
})
