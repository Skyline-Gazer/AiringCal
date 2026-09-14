import assert from 'node:assert/strict'
import test from 'node:test'
import { BgmClient, BgmHttpError, BgmNetworkError } from '@airing-cal/bgm-api'
import { createUpstreamBgmClient, fetchCompleteInput, UpstreamFetchError } from './fetch.js'

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

test('fetchCompleteInput fetches every page and calendar before returning a complete observation', async () => {
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
  assert.equal(result.calendar[0]?.items[0]?.name, '')
})

test('fetchCompleteInput requires every configured user and protects the primary input', async () => {
  const calls: string[] = []
  const users = [
    { userId: 'primary', username: 'alice' },
    { userId: 'secondary', username: 'bob' },
  ]
  const client = {
    getCollections: async (username: string) => {
      calls.push(username)
      if (username === 'bob') throw new BgmNetworkError('temporary secret')
      return { total: 0, offset: 0, limit: 1, data: [] }
    },
    getCalendar: async () => calendar,
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput({ ...config, users }, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError
      && error.category === 'network'
      && error.stage === 'collections'
      && error.attempt === 3,
  )
  assert.deepEqual(calls, ['alice', 'bob', 'bob', 'bob'])
})

test('fetchCompleteInput fails closed on pagination drift, missing pages, and duplicate subjects', async () => {
  for (const mode of ['drift', 'missing', 'duplicate'] as const) {
    const calls: number[] = []
    const client = {
      getCollections: async (_username: string, offset: number) => {
        calls.push(offset)
        if (offset === 0) {
          return { total: 2, offset: 0, limit: 1, data: [entry(1)] }
        }
        if (mode === 'drift') return { total: 3, offset: 1, limit: 1, data: [entry(2)] }
        if (mode === 'missing') return undefined
        return { total: 2, offset: 1, limit: 1, data: [entry(1)] }
      },
      getCalendar: async () => calendar,
    } as unknown as BgmClient

    await assert.rejects(
      () => fetchCompleteInput(config, client, () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError
        && error.category === 'contract'
        && error.stage === 'collections'
        && error.attempt === 1,
    )
    assert.deepEqual(calls, [0, 1])
  }
})

test('fetchCompleteInput stops before calendar when a collection page exhausts retries', async () => {
  const calls: string[] = []
  const client = {
    getCollections: async (_username: string, offset: number) => {
      calls.push(`collections:${offset}`)
      if (offset === 0) return { total: 2, offset: 0, limit: 1, data: [entry(1)] }
      throw new BgmNetworkError('temporary failure')
    },
    getCalendar: async () => {
      calls.push('calendar')
      return calendar
    },
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError && error.attempt === 3,
  )
  assert.deepEqual(calls, ['collections:0', 'collections:1', 'collections:1', 'collections:1'])
})

test('fetchCompleteInput rejects an incomplete calendar as a contract failure', async () => {
  let calendarCalls = 0
  const client = {
    getCollections: async () => ({ total: 0, offset: 0, limit: 1, data: [] }),
    getCalendar: async () => {
      calendarCalls++
      return [{ weekday: {}, items: [] }]
    },
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchCompleteInput(config, client, () => 1_000),
    (error: unknown) => error instanceof UpstreamFetchError
      && error.category === 'contract'
      && error.stage === 'complete'
      && error.attempt === 1,
  )
  assert.equal(calendarCalls, 1)
})

test('fetchCompleteInput maps actual BgmClient failures and proves only outer retry attempts', async () => {
  for (const status of [401, 403]) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ error: 'secret body' }), { status })
    }
    try {
      await assert.rejects(
        () => fetchCompleteInput(config, createUpstreamBgmClient('token'), () => 1_000),
        (error: unknown) => error instanceof UpstreamFetchError && error.category === 'auth' && error.attempt === 1,
      )
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ error: 'secret body' }), { status: 429 })
  }
  try {
    await assert.rejects(
      () => fetchCompleteInput(config, createUpstreamBgmClient('token'), () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError
        && error.category === 'rate_limited'
        && error.attempt === 3
        && !/secret|bgm\.tv/i.test(error.message),
    )
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCompleteInput treats actual invalid JSON as a terminal contract failure', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('invalid-json-secret', { status: 200 })
  }
  try {
    await assert.rejects(
      () => fetchCompleteInput(config, createUpstreamBgmClient('token'), () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError
        && error.category === 'contract'
        && error.stage === 'collections'
        && error.attempt === 1
        && !/invalid|secret|bgm\.tv/i.test(error.message),
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchCompleteInput rejects a BgmClient with implicit retries before any upstream request', async () => {
  let calls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    calls++
    return new Response('unexpected', { status: 429 })
  }
  try {
    await assert.rejects(
      () => fetchCompleteInput(config, new BgmClient('token'), () => 1_000),
      (error: unknown) => error instanceof UpstreamFetchError && error.code === 'UPSTREAM_CONTRACT' && error.stage === 'config',
    )
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})
