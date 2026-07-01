import assert from 'node:assert/strict'
import test from 'node:test'
import { WatchStatus } from '@airing-cal/domain'
import { BgmPlatformClient } from './index.ts'

function captureFetch(responses: Array<{ match: string; status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url)
    calls.push({ url: text, init })
    const index = responses.findIndex((item) => text.includes(item.match))
    const response = index >= 0 ? responses.splice(index, 1)[0] : undefined
    if (!response) throw new Error(`unexpected fetch: ${text}`)
    return Response.json(response.body, { status: response.status ?? 200 })
  }
  return { calls, fetch: fetch as typeof globalThis.fetch }
}

test('BgmPlatformClient maps Bangumi collections to comparison items', async () => {
  const originalFetch = globalThis.fetch
  const captured = captureFetch([
    {
      match: '/collections?',
      body: {
        total: 1,
        data: [{
          subject_id: 23080,
          type: 3,
          ep_status: 4,
          rate: 8,
          subject: { name: 'A', name_cn: 'A CN', eps: 12, total_episodes: 12 },
        }],
      },
    },
  ])
  globalThis.fetch = captured.fetch

  try {
    const items = await new BgmPlatformClient().fetchCollections('token-a', 'alice')

    assert.equal(items[0]?.externalId, '23080')
    assert.equal(items[0]?.title, 'A CN')
    assert.equal(items[0]?.status, WatchStatus.WATCHING)
    assert.equal(items[0]?.progress, 4)
    assert.equal(items[0]?.totalEpisodes, 12)
    assert.equal(items[0]?.score, 8)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('BgmPlatformClient patchEntry upserts collection and syncs episode progress by type buckets', async () => {
  const originalFetch = globalThis.fetch
  const captured = captureFetch([
    { match: '/collections/23080/episodes?limit=1000&offset=0', body: { total: 2, data: [{ episode: { id: 1 }, type: 2 }, { episode: { id: 2 }, type: 1 }] } },
    { match: '/collections/23080/episodes?limit=1000&offset=0', body: { total: 2, data: [{ episode: { id: 1 }, type: 1 }, { episode: { id: 2 }, type: 1 }] } },
    { match: '/collections/23080/episodes', body: {} },
    { match: '/collections/23080', body: {} },
  ])
  globalThis.fetch = captured.fetch

  try {
    const result = await new BgmPlatformClient().patchEntry('target-token', '23080', {
      externalId: '23080',
      title: 'A CN',
      status: WatchStatus.COMPLETED,
      progress: 1,
      totalEpisodes: 2,
      score: 9,
      platform: 'bgm',
    }, { sourceToken: 'source-token' })

    const upsert = captured.calls.find((call) => call.url.endsWith('/v0/users/-/collections/23080'))
    assert.equal(upsert?.init?.method, 'POST')
    assert.equal((upsert?.init?.headers as Record<string, string>).Authorization, 'Bearer target-token')
    assert.deepEqual(JSON.parse(String(upsert?.init?.body)), { type: 2, rate: 9 })
    assert.equal(result.episodeChanged, 1)
    assert.deepEqual(result.episodeProgress, { before: 0, after: 1, total: 2 })
  } finally {
    globalThis.fetch = originalFetch
  }
})
