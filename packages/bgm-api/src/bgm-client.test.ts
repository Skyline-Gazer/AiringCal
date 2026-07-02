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
      return offset === 0
        ? { total: 31, data: [{ subject_id: 1 }] }
        : { total: 31, data: [{ subject_id: 2 }] }
    },
  } as unknown as BgmClient

  const result = await fetchAllCollections(client, 'alice')

  assert.deepEqual(calls, [{ offset: 0, limit: 30 }, { offset: 30, limit: 30 }])
  assert.deepEqual(result.map((entry) => entry.subject_id), [1, 2])
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
