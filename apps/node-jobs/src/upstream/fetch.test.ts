import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, type BgmCalendarItem, type BgmCollection, type BgmEpisodeCollection } from '@airing-cal/bgm-api'
import { fetchCompleteInput } from './fetch.ts'

const CALENDAR: BgmCalendarItem[] = [
  { weekday: { en: 'Mon', cn: '星期一', ja: '月耀日', id: 1 }, items: [] },
]

function slimSubject(subjectId: number) {
  return {
    id: subjectId,
    type: 2,
    name: `Subject ${subjectId}`,
    name_cn: `条目 ${subjectId}`,
    short_summary: '',
    date: '2026-10-06',
    tags: [{ name: 'tag', count: 1 }],
    score: 7.5,
    eps: 12,
    volumes: 0,
    collection_total: 10,
    rank: 100,
    images: {
      large: 'https://example.test/l.jpg',
      common: 'https://example.test/c.jpg',
      medium: 'https://example.test/m.jpg',
      small: 'https://example.test/s.jpg',
      grid: 'https://example.test/g.jpg',
    },
  }
}

function collection(subjectId: number, overrides: Record<string, unknown> = {}): BgmCollection {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    comment: '',
    tags: [],
    ep_status: 0,
    vol_status: 0,
    updated_at: '2026-10-22T15:33:10+08:00',
    private: false,
    subject: slimSubject(subjectId),
    ...overrides,
  } as unknown as BgmCollection
}

/** Real bgm.tv pages return null for unset optional fields; the client is subclassed to serve fixtures. */
class FixtureClient extends BgmClient {
  constructor(private readonly pages: BgmCollection[][]) {
    super(undefined, { maxGetRetries: 0 })
  }


  override async getCollections(_username: string, offset = 0, limit = 50) {
    const data = this.pages[0] ?? []
    return {
      total: data.length,
      limit,
      offset,
      data: data.slice(offset, offset + limit),
    }
  }

  override async getCalendar() {
    return CALENDAR
  }
}

test('fetchCompleteInput accepts null comment and null subject date as absent', async () => {
  const client = new FixtureClient([
    [
      collection(501, {
        comment: null,
        subject: { ...slimSubject(501), date: null },
      }),
      collection(502),
    ],
  ])
  const result = await fetchCompleteInput(
    { users: [{ userId: '857123', username: 'fixture' }], primaryUserId: '857123' },
    client,
    () => 1_700_000_000_000,
  )
  assert.equal(result.collections.length, 2)
  const first = result.collections[0]?.collection
  assert.equal(first?.subject_id, 501)
  assert.equal(first?.comment, undefined)
  assert.equal(first?.subject?.date, undefined)
  assert.equal(result.collections[1]?.collection.subject?.date, '2026-10-06')
})

test('fetchCompleteInput still rejects null required fields', async () => {
  const client = new FixtureClient([
    [collection(501, { subject_id: null }), collection(502)],
  ])
  await assert.rejects(
    () =>
      fetchCompleteInput(
        { users: [{ userId: '857123', username: 'fixture' }], primaryUserId: '857123' },
        client,
        () => 1_700_000_000_000,
      ),
    /UPSTREAM_CONTRACT/,
  )
})

// ---------------------------------------------------------------------------
// #195 P3: per-episode progress fetch orchestration
// ---------------------------------------------------------------------------

class EpisodeFixtureClient extends BgmClient {
  episodeCalls: number[] = []
  catalogCalls: number[] = []
  constructor(
    private readonly collections: BgmCollection[],
    private readonly opts: { failEpisodes?: boolean; failCatalog?: boolean } = {},
  ) {
    super(undefined, { maxGetRetries: 0 })
  }

  override async getCollections(_username: string, offset = 0, limit = 50) {
    return {
      total: this.collections.length,
      limit,
      offset,
      data: this.collections.slice(offset, offset + limit),
    }
  }

  override async getCalendar() {
    return CALENDAR
  }

  override async getSubjectEpisodeCollections(_token: string, subjectId: number): Promise<{ total: number; data: BgmEpisodeCollection[] }> {
    this.episodeCalls.push(subjectId)
    if (this.opts.failEpisodes) throw new Error('episode collection fetch failed')
    if (subjectId === 900) {
      // non-contiguous: 1 and 3 watched, 2 not; SP watched
      return {
        total: 4,
        data: [
          { episode: { id: 1, type: 0, sort: 1, ep: 1 }, type: 2, updated_at: 10 },
          { episode: { id: 2, type: 0, sort: 2, ep: 2 }, type: 0, updated_at: 0 },
          { episode: { id: 3, type: 0, sort: 3, ep: 3 }, type: 2, updated_at: 12 },
          { episode: { id: 4, type: 1, sort: 1, ep: 0 }, type: 2, updated_at: 13 },
        ],
      }
    }
    return { total: 0, data: [] }
  }

  override async getSubjectEpisodeCatalog(subjectId: number) {
    this.catalogCalls.push(subjectId)
    if (this.opts.failCatalog) throw new Error('catalog fetch failed')
    if (subjectId === 900) {
      return [
        { id: 1, type: 0, sort: 1, ep: 1, airdate: '2026-01-01' },
        { id: 2, type: 0, sort: 2, ep: 2, airdate: '2026-01-08' },
        { id: 3, type: 0, sort: 3, ep: 3, airdate: '2026-01-15' },
        { id: 4, type: 1, sort: 4, ep: 0, airdate: '2026-06-01' },
      ]
    }
    return []
  }
}

const CONFIG = { users: [{ userId: '42', username: 'owner' }], primaryUserId: '42' }

test('fetchCompleteInput merges non-contiguous episode states with catalog types for the token owner (#195)', async () => {
  const client = new EpisodeFixtureClient([
    collection(900, { type: 3, ep_status: 3, private: true }),
    collection(901, { type: 1 }),
  ])
  const input = await fetchCompleteInput(CONFIG, client, () => 1_767_225_600_000, {
    tokenUserId: '42',
  })
  assert.deepEqual(client.episodeCalls, [900], 'watched subject fetched; want-to-watch skipped')
  assert.deepEqual(client.catalogCalls, [900])
  assert.equal(input.episodeProgress.length, 1)
  const subject = input.episodeProgress[0]
  assert.equal(subject.user_id, '42')
  assert.equal(subject.subject_id, 900)
  assert.equal(subject.episodes.length, 4)
  const watched = subject.episodes.filter((e) => e.collection_type === 2).map((e) => e.episode_id)
  assert.deepEqual(watched, [1, 3, 4], 'non-contiguous states preserved verbatim')
  assert.equal(subject.episodes.find((e) => e.episode_id === 4)?.episode_type, 1, 'SP distinguishable via catalog type')
  assert.equal(subject.episodes.find((e) => e.episode_id === 2)?.collection_type, 0, 'unwatched gap explicit')
})

test('fetchCompleteInput skips episode fetch for non token-owner users and when disabled (#195)', async () => {
  const client = new EpisodeFixtureClient([collection(900, { type: 3 })])
  const other = await fetchCompleteInput(CONFIG, client, () => 1_767_225_600_000, {
    tokenUserId: 'DIFFERENT',
  })
  assert.deepEqual(other.episodeProgress, [])
  assert.deepEqual(client.episodeCalls, [], 'never query users/- for a different identity')

  const client2 = new EpisodeFixtureClient([collection(900, { type: 3 })])
  const off = await fetchCompleteInput(CONFIG, client2, () => 1_767_225_600_000)
  assert.deepEqual(off.episodeProgress, [])
  assert.deepEqual(client2.episodeCalls, [])
})

test('fetchCompleteInput fails closed when episode fetch is incomplete, without partial data (#195)', async () => {
  const client = new EpisodeFixtureClient([collection(900, { type: 3 })], { failEpisodes: true })
  await assert.rejects(
    () => fetchCompleteInput(CONFIG, client, () => 1_767_225_600_000, { tokenUserId: '42' }),
    /episode/i,
  )
  const client2 = new EpisodeFixtureClient([collection(900, { type: 3 })], { failCatalog: true })
  await assert.rejects(
    () => fetchCompleteInput(CONFIG, client2, () => 1_767_225_600_000, { tokenUserId: '42' }),
    /catalog|episode/i,
  )
})
