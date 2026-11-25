import test from 'node:test'
import assert from 'node:assert/strict'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { parseCorsAllowedOrigins } from './read-config.ts'
import type { PublicStore } from '@airing-cal/v3-core/ports'

const store: PublicStore = {
  async getCurrentRelease() {
    return null
  },
  async headObject() {
    return null
  },
  async getSnapshotBytes() {
    return null
  },
  async putImmutableObject(key: string): Promise<void> {
    throw new Error(`unexpected write ${key}`)
  },
  async commitRelease(): Promise<never> {
    throw new Error('unexpected commit')
  },
}

function req(method: string, origin?: string) {
  const headers: Record<string, string> = {}
  if (origin) headers.Origin = origin
  return new Request('https://reader.test/public/current-release.json', { method, headers })
}

test('parseCorsAllowedOrigins keeps exact origins and refuses wildcards', () => {
  assert.deepEqual(parseCorsAllowedOrigins(undefined), [])
  assert.deepEqual(parseCorsAllowedOrigins('  '), [])
  assert.deepEqual(
    parseCorsAllowedOrigins('https://a.test, https://b.test/,https://a.test'),
    ['https://a.test', 'https://b.test'],
  )
  assert.deepEqual(parseCorsAllowedOrigins('null'), ['null'])
  assert.throws(() => parseCorsAllowedOrigins('https://*.test'), /no wildcards/)
  assert.throws(() => parseCorsAllowedOrigins('a.test'), /absolute http\(s\) origins/)
})

test('preflight is answered by the Worker only when the origin is allowlisted', async () => {
  const env = { publicStore: store, corsAllowedOrigins: ['https://embed.test'] }

  const hit = await handlePortableReadRequest(req('OPTIONS', 'https://embed.test'), env)
  assert.equal(hit.status, 204)
  assert.equal(hit.headers.get('Access-Control-Allow-Origin'), 'https://embed.test')
  assert.equal(hit.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD')
  assert.equal(hit.headers.get('Access-Control-Max-Age'), '86400')

  const miss = await handlePortableReadRequest(req('OPTIONS', 'https://evil.test'), env)
  assert.equal(miss.status, 405, 'non-listed preflight gets the plain method refusal')
  assert.equal(miss.headers.get('Access-Control-Allow-Origin'), null)
})

test('without an allowlist the Worker keeps OPTIONS at 405 (edge-owned CORS)', async () => {
  const res = await handlePortableReadRequest(req('OPTIONS', 'https://embed.test'), { publicStore: store })
  assert.equal(res.status, 405)
  assert.equal(res.headers.get('Allow'), 'GET, HEAD')
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null)
})

test('GET responses carry ACAO+Vary only for allowlisted origins', async () => {
  const env = { publicStore: store, corsAllowedOrigins: ['https://embed.test'] }
  const allowed = await handlePortableReadRequest(req('GET', 'https://embed.test'), env)
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://embed.test')
  assert.equal(allowed.headers.get('Vary'), 'Origin')
  const denied = await handlePortableReadRequest(req('GET', 'https://other.test'), env)
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null)
  const anonymous = await handlePortableReadRequest(req('GET'), env)
  assert.equal(anonymous.headers.get('Access-Control-Allow-Origin'), null)
})
