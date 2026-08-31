import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, BgmHttpError, BgmNetworkError } from '@airing-cal/bgm-api'
import { fetchCompleteInput, createUpstreamBgmClient, UpstreamFetchError } from './fetch.ts'

const entry = (subjectId: number) => ({
  subject_id: subjectId,
  subject_type: 2,
  rate: 0,
  type: 3,
  comment: '',
  tags: [],
  ep_status: 0,
  vol_status: 0,
  updated_at: '2026-08-31T00:00:00.000Z',
  private: false,
})

const calendar = [{
  weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
  items: [{ id: 1, type: 2 }],
}]

const config = {
  users: [{ userId: 'primary', username: 'alice' }],
  primaryUserId: 'primary',
  pageLimit: 1,
  retry: { sleep: async () => undefined, random: () => 0.5, now: () => 0 },
}

test('fetchCompleteInput fetches every page and calendar before returning a complete seconds observation', async () => {
  const calls: string[] = []
  const client = {
    getCollections: async (_username: string, offset: number, limit: number) => {
      calls.push(`collections:${offset}:${limit}`)
      return offset === 0
        ? { total: 2, offset: 0, limit: 1, data: [entry(1)] }
        : { total: 2, offset: 1, limit: 1, data: [entry(2)] }
    },
    getCalendar: async () => {
      calls.push('calendar')
      return calendar
    },
  } as unknown as BgmClient

  const result = await fetchCompleteInput(config, client, () => 123_999)

  assert.deepEqual(calls, ['collections:0:1', 'collections:1:1', 'calendar'])
  assert.equal(result.complete, true)
  assert.equal(result.observedAt, 123)
  assert.deepEqual(result.collections.map(({ collection }) => collection.subject_id), [1, 2])
})

test('fetchCompleteInput fails closed when a pagination total drifts before requesting another page', async () => {
  let calls = 0
  const client = {
    getCollections: async (_username: string, offset: number) => {
      calls++
      return offset === 0
        ? { total: 3, offset: 0, limit: 1, data: [entry(1)] }
        : { total: 4, offset: 1, limit: 1, data: [entry(2)] }
    },
    getCalendar: async () => calendar,
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError && error.category === 'contract' && error.stage === 'collections',
  )
  assert.equal(calls, 2)
})

test('fetchCompleteInput rejects duplicate subjects in the first page before continuing pagination', async () => {
  let calls = 0
  const client = {
    getCollections: async () => {
      calls++
      return { total: 3, offset: 0, limit: 2, data: [entry(1), entry(1)] }
    },
    getCalendar: async () => calendar,
  } as unknown as BgmClient
  const duplicateConfig = { ...config, pageLimit: 2 }

  await assert.rejects(
    () => fetchCompleteInput(duplicateConfig, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError && error.category === 'contract' && error.stage === 'collections',
  )
  assert.equal(calls, 1)
})

test('fetchCompleteInput treats calendar 404 as terminal rather than a complete empty calendar', async () => {
  let calls = 0
  const client = {
    getCollections: async () => ({ total: 0, offset: 0, limit: 1, data: [] }),
    getCalendar: async () => {
      calls++
      throw new BgmHttpError(404, 'https://api.bgm.tv/calendar')
    },
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError && error.category === 'not_found' && error.attempt === 1,
  )
  assert.equal(calls, 1)
})

test('fetchCompleteInput retries each actual BgmClient request only three times when its built-in retry is disabled', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ title: 'retry' }), { status: 429, headers: { 'Retry-After': '0' } })
  }
  try {
    await assert.rejects(
      () => fetchCompleteInput(config, createUpstreamBgmClient('token-value'), () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError && error.category === 'rate_limited' && error.attempt === 3,
    )
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCompleteInput treats actual BgmClient 401 and 403 responses as one-attempt authentication failures', async () => {
  for (const status of [401, 403]) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ title: 'denied' }), { status })
    }
    try {
      await assert.rejects(
        () => fetchCompleteInput(config, createUpstreamBgmClient('token-value'), () => 1_000),
        (error: unknown) => error instanceof UpstreamFetchError && error.category === 'auth' && error.attempt === 1,
      )
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('fetchCompleteInput fails closed for actual BgmClient collection and calendar 404 responses', async () => {
  for (const stage of ['collections', 'calendar'] as const) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      if (stage === 'calendar' && calls === 1) return Response.json({ total: 0, offset: 0, limit: 1, data: [] })
      return new Response(JSON.stringify({ title: 'not found' }), { status: 404 })
    }
    try {
      await assert.rejects(
        () => fetchCompleteInput(config, createUpstreamBgmClient('token-value'), () => 1_000),
        (error: unknown) => error instanceof UpstreamFetchError && error.category === 'not_found' && error.stage === stage && error.attempt === 1,
      )
      assert.equal(calls, stage === 'calendar' ? 2 : 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('fetchCompleteInput bounds actual BgmClient 5xx and timeout failures to three requests', async () => {
  for (const failure of [
    () => new Response(JSON.stringify({ title: 'unavailable' }), { status: 503 }),
    () => { throw new DOMException('timed out', 'TimeoutError') },
  ]) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return failure()
    }
    try {
      await assert.rejects(
        () => fetchCompleteInput(config, createUpstreamBgmClient('token-value'), () => 1_000),
        (error: unknown) => error instanceof UpstreamFetchError && error.attempt === 3,
      )
      assert.equal(calls, 3)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('fetchCompleteInput bounds transient network failures per request', async () => {
  let calls = 0
  const client = {
    getCollections: async () => {
      calls++
      throw new BgmNetworkError('ECONNRESET https://api.bgm.tv/?token=secret')
    },
    getCalendar: async () => calendar,
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamFetchError)
      assert.deepEqual({ category: error.category, stage: error.stage, attempt: error.attempt }, {
        category: 'network', stage: 'collections', attempt: 3,
      })
      assert.doesNotMatch(error.message, /secret|api\.bgm/)
      return true
    },
  )
  assert.equal(calls, 3)
})

test('fetchCompleteInput refuses a BgmClient whose implicit retry is enabled before any upstream call', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ title: 'retry' }), { status: 429, headers: { 'Retry-After': '0' } })
  }
  try {
    await assert.rejects(
      () => fetchCompleteInput(config, new BgmClient('token-value'), () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError && error.code === 'UPSTREAM_CONTRACT' && error.stage === 'config',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCompleteInput rejects an OpenAPI collection subject with an invalid subject type', async () => {
  const client = {
    getCollections: async () => ({
      total: 1,
      offset: 0,
      limit: 1,
      data: [{ ...entry(1), subject: { id: 1, type: 5, name: 'bad type', name_cn: '', short_summary: '', tags: [], score: 0, eps: 0, volumes: 0, collection_total: 0, rank: 0, images: { large: '', common: '', medium: '', small: '', grid: '' } } }],
    }),
    getCalendar: async () => calendar,
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError && error.category === 'contract' && error.stage === 'collections',
  )
})
