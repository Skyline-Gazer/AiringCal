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

test('BgmPlatformClient patches 201 changed episodes in batches of at most 100', async () => {
  const originalFetch = globalThis.fetch
  const patchSizes: number[] = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    if (text.endsWith('/collections/23080')) return Response.json({})
    if (text.includes('/episodes?')) {
      const token = (init?.headers as Record<string, string>).Authorization
      const data = token === 'Bearer source-token'
        ? Array.from({ length: 201 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 }))
        : Array.from({ length: 201 }, (_, index) => ({ episode: { id: index + 1 }, type: 1 }))
      return Response.json({ total: 201, data })
    }
    const body = JSON.parse(String(init?.body)) as { episode_id: number[] }
    patchSizes.push(body.episode_id.length)
    return Response.json({})
  }
  try {
    const result = await new BgmPlatformClient().patchEntry('target-token', '23080', {
      externalId: '23080', title: 'A', status: WatchStatus.COMPLETED, progress: 201,
      totalEpisodes: 201, score: 9, platform: 'bgm',
    }, { sourceToken: 'source-token' })

    assert.deepEqual(patchSizes, [100, 100, 1])
    assert.equal(result.episodeChanged, 201)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('BgmPlatformClient exposes structured partial evidence when the second episode batch fails', async () => {
  const originalFetch = globalThis.fetch
  let patchBatch = 0
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    if (text.endsWith('/collections/23080')) return Response.json({})
    if (text.includes('/episodes?')) {
      const token = (init?.headers as Record<string, string>).Authorization
      const data = Array.from({ length: 201 }, (_, index) => ({
        episode: { id: index + 1 }, type: token === 'Bearer source-token' ? 2 : 1,
      }))
      return Response.json({ total: 201, data })
    }
    patchBatch++
    return patchBatch === 2
      ? Response.json({ title: 'failed' }, { status: 500 })
      : Response.json({})
  }
  try {
    await assert.rejects(
      () => new BgmPlatformClient().patchEntry('target-token', '23080', {
        externalId: '23080', title: 'A', status: WatchStatus.COMPLETED, progress: 201,
        totalEpisodes: 201, score: 9, platform: 'bgm',
      }, { sourceToken: 'source-token' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        const partial = error as Error & { code?: string; succeeded?: number; failedBatch?: { index: number; episodeIds: number[] }; cause?: unknown }
        assert.equal(partial.code, 'EPISODE_PATCH_PARTIAL')
        assert.equal(partial.succeeded, 100)
        assert.deepEqual(partial.failedBatch, { index: 1, episodeIds: Array.from({ length: 100 }, (_, index) => index + 101) })
        assert.ok(partial.cause instanceof Error)
        assert.doesNotMatch(error.message, /source-token|target-token/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('BgmPlatformClient keeps succeeded count and batch index global across type buckets', async () => {
  const originalFetch = globalThis.fetch
  const patches: Array<{ type: number; episodeIds: number[] }> = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    if (text.endsWith('/collections/23080')) return Response.json({})
    if (text.includes('/episodes?')) {
      const source = (init?.headers as Record<string, string>).Authorization === 'Bearer source-token'
      const data = source
        ? [
            ...Array.from({ length: 101 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 })),
            ...Array.from({ length: 2 }, (_, index) => ({ episode: { id: index + 102 }, type: 3 })),
          ]
        : Array.from({ length: 103 }, (_, index) => ({ episode: { id: index + 1 }, type: 1 }))
      return Response.json({ total: 103, data })
    }
    const body = JSON.parse(String(init?.body)) as { type: number; episode_id: number[] }
    patches.push({ type: body.type, episodeIds: body.episode_id })
    return patches.length === 3
      ? Response.json({ title: 'failed' }, { status: 500 })
      : Response.json({})
  }
  try {
    await assert.rejects(
      () => new BgmPlatformClient().patchEntry('target-token', '23080', {
        externalId: '23080', title: 'A', status: WatchStatus.COMPLETED, progress: 103,
        totalEpisodes: 103, score: 9, platform: 'bgm',
      }, { sourceToken: 'source-token' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        const partial = error as Error & { succeeded?: number; failedBatch?: { index: number; episodeIds: number[] } }
        assert.equal(partial.succeeded, 101)
        assert.deepEqual(partial.failedBatch, { index: 2, episodeIds: [102, 103] })
        assert.deepEqual(patches.map(({ type, episodeIds }) => [type, episodeIds.length]), [[2, 100], [2, 1], [3, 2]])
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
