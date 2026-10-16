import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

class ContractKv {
  values = new Map<string, unknown>()

  async get(key: string, type?: 'json') {
    const value = this.values.get(key)
    if (type === 'json') return value ?? null
    return value == null ? null : JSON.stringify(value)
  }

  async put(key: string, value: string) {
    this.values.set(key, JSON.parse(value))
  }

  async delete(key: string) {
    this.values.delete(key)
  }

  async list() {
    return { keys: [], list_complete: true }
  }
}

function readEnv(kv = new ContractKv()) {
  return {
    AIRING_CAL_KV: kv,
    AIRING_CAL_D1: {
      async getAppState() {
        return undefined
      },
      prepare() {
        return { bind() { return { async first() { return null } } } }
      },
    },
    AIRING_CAL_DATA_R2: { async get() { return null } },
    AIRING_CAL_R2: { async get() { return null } },
    NSFW_SHOW: 'false',
  }
}

type ContractCase = {
  name: string
  path: string
  method?: string
  expectStatus: number
  cachePattern?: RegExp
  assertJson?: (body: unknown) => void
}

const DEPRECATED_SYNC_ASSERT = (body: unknown) => {
  const json = body as { ok: boolean; error: { code: string } }
  assert.equal(json.ok, false)
  assert.equal(json.error.code, 'DEPRECATED')
}

/** Table-driven public API contract (#69). Paths match `public/src/bangumi.js` and `index.ts`. */
const PUBLIC_API_CONTRACT: ContractCase[] = [
  {
    name: 'deprecated sync compare',
    path: '/api/sync/compare',
    expectStatus: 410,
    cachePattern: /no-store/,
    assertJson: DEPRECATED_SYNC_ASSERT,
  },
  {
    name: 'deprecated sync apply',
    path: '/api/sync/apply',
    method: 'POST',
    expectStatus: 410,
    cachePattern: /no-store/,
    assertJson: DEPRECATED_SYNC_ASSERT,
  },
  {
    name: 'deprecated sync check',
    path: '/api/check/operation-id',
    expectStatus: 410,
    cachePattern: /no-store/,
    assertJson: DEPRECATED_SYNC_ASSERT,
  },
  {
    name: 'version metadata',
    path: '/api/version',
    expectStatus: 200,
    cachePattern: /max-age=60/,
    assertJson: (body) => {
      const json = body as { package: { name: string }; git: { commit: string | null } }
      assert.equal(json.package.name, '@airing-cal/web-worker')
      assert.ok('commit' in json.git)
    },
  },
  {
    name: 'health envelope',
    path: '/api/health',
    expectStatus: 200,
    assertJson: (body) => {
      const json = body as { ok: boolean; worker: string; data: Record<string, unknown> }
      assert.equal(json.ok, true)
      assert.equal(json.worker, 'web-worker')
      assert.ok(json.data.collections)
      assert.ok(json.data.cache)
    },
  },
  {
    name: 'config nsfw key',
    path: '/api/config?key=nsfw',
    expectStatus: 200,
    cachePattern: /max-age=60/,
    assertJson: (body) => {
      const json = body as { nsfw: boolean }
      assert.equal(typeof json.nsfw, 'boolean')
    },
  },
  {
    name: 'collections query shape',
    path: '/api/collections?type=watching&page=1&limit=24',
    expectStatus: 200,
    cachePattern: /s-maxage=300/,
    assertJson: (body) => {
      const json = body as { data: unknown[]; total: number; page: number; limit: number }
      assert.ok(Array.isArray(json.data))
      assert.equal(typeof json.total, 'number')
      assert.equal(json.page, 1)
      assert.equal(json.limit, 24)
    },
  },
  {
    name: 'calendar json array',
    path: '/api/calendar',
    expectStatus: 200,
    cachePattern: /s-maxage=600/,
    assertJson: (body) => {
      assert.ok(Array.isArray(body))
    },
  },
]

test('public API contract table (index.ts routes)', async () => {
  const env = readEnv()
  for (const spec of PUBLIC_API_CONTRACT) {
    const response = await worker.fetch(
      new Request(`https://airingcal.test${spec.path}`, { method: spec.method ?? 'GET' }),
      env as never,
    )
    assert.equal(response.status, spec.expectStatus, spec.name)
    if (spec.cachePattern) {
      assert.match(response.headers.get('Cache-Control') ?? '', spec.cachePattern, spec.name)
    }
    if (spec.assertJson) {
      spec.assertJson(await response.json())
    }
  }
})
