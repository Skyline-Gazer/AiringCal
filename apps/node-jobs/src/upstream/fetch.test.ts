import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, type BgmCalendarItem, type BgmCollection } from '@airing-cal/bgm-api'
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
