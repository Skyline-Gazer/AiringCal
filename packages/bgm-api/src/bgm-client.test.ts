import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BgmClient, BgmHttpError, fetchAllCollections } from './index.ts'

function apiSpec(): any {
  return JSON.parse(readFileSync(new URL('../../../docs/example/api/bgm-api.json', import.meta.url), 'utf8'))
}

function captureFetch(status = 200, body: unknown = {}): { calls: { url: string; init?: RequestInit }[]; fetch: typeof globalThis.fetch } {
  const calls: { url: string; init?: RequestInit }[] = []
  return {
    calls,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }) as unknown as Response
    },
  }
}

test('OpenAPI confirms GET /v0/subjects/{subject_id} returns Subject with optional bearer and nsfw', () => {
  const spec = apiSpec()
  const subjectDetail = spec.paths['/v0/subjects/{subject_id}'].get
  const subjectSchema = spec.components.schemas.Subject

  assert.equal(subjectDetail.operationId, 'getSubjectById')
  assert.deepEqual(subjectDetail.security, [{ OptionalHTTPBearer: [] }])
  assert.equal(subjectSchema.properties.nsfw.type, 'boolean')
})

test('OpenAPI confirms GET /calendar returns legacy subjects with eps_count', () => {
  const spec = apiSpec()
  const calendarItems = spec.paths['/calendar'].get.responses['200'].content['application/json'].schema.items.properties.items.items
  const legacySubject = spec.components.schemas.Legacy_SubjectSmall

  assert.equal(calendarItems.$ref, '#/components/schemas/Legacy_SubjectSmall')
  assert.equal(legacySubject.properties.eps_count.type, 'integer')
})

test('getSubject fetches full subject detail with bearer token when configured', async () => {
  const client = new BgmClient('token-a')
  const originalFetch = globalThis.fetch
  const captured = captureFetch(200, { id: 23080, name: 'Test', nsfw: true })
  globalThis.fetch = captured.fetch
  try {
    const subject = await client.getSubject(23080)

    assert.equal(captured.calls[0].url, 'https://api.bgm.tv/v0/subjects/23080')
    assert.equal((captured.calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer token-a')
    assert.equal(subject?.nsfw, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getSubject returns null for 404 so callers can apply restricted NSFW policy', async () => {
  const client = new BgmClient('token-a')
  const originalFetch = globalThis.fetch
  globalThis.fetch = captureFetch(404, { title: 'Not Found' }).fetch
  try {
    assert.equal(await client.getSubject(23080), null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchAllCollections paginates collection API through BgmClient', async () => {
  const calls: Array<{ offset: number; limit: number }> = []
  const client = {
    getCollections: async (_username: string, offset: number, limit: number) => {
      calls.push({ offset, limit })
      return { total: 549, data: [{ subject_id: offset + 1 }] }
    },
  } as unknown as BgmClient

  const result = await fetchAllCollections(client, 'alice')

  assert.equal(calls.length, 11)
  assert.deepEqual(calls, Array.from({ length: 11 }, (_, index) => ({ offset: index * 50, limit: 50 })))
  assert.deepEqual(result.map((entry) => entry.subject_id), Array.from({ length: 11 }, (_, index) => index * 50 + 1))
})

test('GET retries 429 and 5xx responses at most twice', async () => {
  const originalFetch = globalThis.fetch
  const statuses = [429, 503, 200]
  let calls = 0
  globalThis.fetch = async () => {
    const status = statuses[calls++]
    return new Response(JSON.stringify(status === 200 ? [] : { title: 'retry' }), {
      status,
      headers: status === 429 ? { 'Retry-After': '0' } : undefined,
    })
  }
  try {
    const client = new BgmClient(undefined, { retryBaseDelayMs: 0 })
    assert.deepEqual(await client.getCalendar(), [])
    assert.equal(calls, 3)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('BgmHttpError exposes Retry-After metadata without changing its constructor call shape', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ title: 'slow down' }), {
    status: 429,
    headers: { 'Retry-After': '7' },
  })
  try {
    await assert.rejects(
      () => new BgmClient(undefined, { maxGetRetries: 0 }).getCalendar(),
      (error: unknown) => {
        assert.ok(error instanceof BgmHttpError)
        assert.equal(error.retryAfter, '7')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET retries timeout and network failures', async () => {
  for (const failure of [new DOMException('timed out', 'TimeoutError'), new TypeError('network down')]) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      if (calls === 1) throw failure
      return new Response(JSON.stringify([]), { status: 200 })
    }
    try {
      const client = new BgmClient(undefined, { retryBaseDelayMs: 0 })
      assert.deepEqual(await client.getCalendar(), [])
      assert.equal(calls, 2)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('patchSubjectEpisodeCollections rejects batches outside the supported 1 to 100 range', async () => {
  const client = new BgmClient('token-a')
  const originalFetch = globalThis.fetch
  const captured = captureFetch(204, '')
  globalThis.fetch = captured.fetch
  try {
    await assert.rejects(client.patchSubjectEpisodeCollections('token-a', 23080, [], 2), /between 1 and 100/)
    await assert.rejects(
      client.patchSubjectEpisodeCollections('token-a', 23080, Array.from({ length: 101 }, (_, index) => index + 1), 2),
      /between 1 and 100/,
    )
    assert.equal(captured.calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('GET does not retry 401 or 403 responses', async () => {
  for (const status of [401, 403]) {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return new Response(JSON.stringify({ title: 'denied' }), { status })
    }
    try {
      await assert.rejects(() => new BgmClient(undefined, { retryBaseDelayMs: 0 }).getCalendar(), BgmHttpError)
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('write requests are never retried implicitly', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ title: 'unavailable' }), { status: 503 })
  }
  try {
    await assert.rejects(() => new BgmClient(undefined, { retryBaseDelayMs: 0 }).patchCollection('token', 1, { type: 3 }), BgmHttpError)
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchAllCollections stops when its total budget is exhausted', async () => {
  let now = 0
  const client = {
    getCollections: async () => {
      now += 121_000
      return { total: 100, data: [{ subject_id: 1 }] }
    },
  } as unknown as BgmClient

  await assert.rejects(
    () => fetchAllCollections(client, 'alice', { now: () => now, budgetMs: 120_000 }),
    /120s/,
  )
})

test('fetchJson classifies non-404 upstream errors as BgmHttpError', async () => {
  const client = new BgmClient()
  const originalFetch = globalThis.fetch
  globalThis.fetch = captureFetch(403, { title: 'Forbidden' }).fetch
  try {
    await assert.rejects(() => client.getSubject(1), BgmHttpError)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getSubjectEpisodeCollections fetches all 1001 episode collections', async () => {
  const originalFetch = globalThis.fetch
  const offsets: number[] = []
  globalThis.fetch = async (url) => {
    const offset = Number(new URL(String(url)).searchParams.get('offset'))
    offsets.push(offset)
    const count = offset === 0 ? 1000 : 1
    return Response.json({
      total: 1001,
      data: Array.from({ length: count }, (_, index) => ({ episode: { id: offset + index + 1 }, type: 2 })),
    })
  }
  try {
    const result = await new BgmClient().getSubjectEpisodeCollections('secret-token', 23080)

    assert.deepEqual(offsets, [0, 1000])
    assert.equal(result.data.length, 1001)
    assert.equal(result.total, 1001)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('getSubjectEpisodeCollections rejects an empty page before total with a stable code and no token', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => Response.json(calls++ === 0
    ? { total: 1001, data: Array.from({ length: 1000 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 })) }
    : { total: 1001, data: [] })
  try {
    await assert.rejects(
      () => new BgmClient().getSubjectEpisodeCollections('secret-token', 23080),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as Error & { code?: string }).code, 'EPISODE_PAGINATION_EMPTY_PAGE')
        assert.match(error.message, /subject 23080.*offset 1000.*total 1001/)
        assert.doesNotMatch(error.message, /secret-token/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const scenario of [
  {
    name: 'a changed total after the first page',
    pages: [
      { total: 1001, data: Array.from({ length: 1000 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 })) },
      { total: 1002, data: [{ episode: { id: 1001 }, type: 2 }] },
    ],
  },
  {
    name: 'accumulated rows exceeding the first total',
    pages: [
      { total: 1001, data: Array.from({ length: 1000 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 })) },
      { total: 1001, data: [{ episode: { id: 1001 }, type: 2 }, { episode: { id: 1002 }, type: 2 }] },
    ],
  },
  {
    name: 'a duplicate episode ID across pages',
    pages: [
      { total: 1001, data: Array.from({ length: 1000 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 })) },
      { total: 1001, data: [{ episode: { id: 1000 }, type: 2 }] },
    ],
  },
] as const) {
  test(`getSubjectEpisodeCollections rejects ${scenario.name} with a stable pagination error`, async () => {
    const originalFetch = globalThis.fetch
    let page = 0
    globalThis.fetch = async () => Response.json(scenario.pages[page++])
    try {
      await assert.rejects(
        () => new BgmClient().getSubjectEpisodeCollections('secret-token', 23080),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { code?: string }).code, 'EPISODE_PAGINATION_INCONSISTENT')
          assert.doesNotMatch(error.message, /secret-token/)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('getSubjectEpisodeCollections rejects a non-empty page with no unique progress', async () => {
  const originalFetch = globalThis.fetch
  let page = 0
  const firstPage = Array.from({ length: 1000 }, (_, index) => ({ episode: { id: index + 1 }, type: 2 }))
  globalThis.fetch = async () => Response.json(page++ === 0
    ? { total: 1002, data: firstPage }
    : { total: 1002, data: [{ episode: { id: 999 }, type: 2 }, { episode: { id: 1000 }, type: 2 }] })
  try {
    await assert.rejects(
      () => new BgmClient().getSubjectEpisodeCollections('secret-token', 23080),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal((error as Error & { code?: string }).code, 'EPISODE_PAGINATION_INCONSISTENT')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const total of [Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
  test(`getSubjectEpisodeCollections rejects invalid first-page total ${String(total)}`, async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => Response.json({ total, data: [] })
    try {
      await assert.rejects(
        () => new BgmClient().getSubjectEpisodeCollections('secret-token', 23080),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal((error as Error & { code?: string }).code, 'EPISODE_PAGINATION_INCONSISTENT')
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('downloadImage normalizes protocol-relative bgm image urls before fetching', async () => {
  const client = new BgmClient()
  const originalFetch = globalThis.fetch
  const captured = captureFetch(200, 'image-bytes')
  globalThis.fetch = captured.fetch
  try {
    const image = await client.downloadImage('//lain.bgm.tv/pic/cover/c/test.jpg')

    assert.equal(captured.calls[0].url, 'https://lain.bgm.tv/pic/cover/c/test.jpg')
    assert.equal(image?.contentType, 'text/plain;charset=UTF-8')
  } finally {
    globalThis.fetch = originalFetch
  }
})
