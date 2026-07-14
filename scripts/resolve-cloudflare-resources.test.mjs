import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCloudflareResources } from './resolve-cloudflare-resources.mjs'

function response(result, success = true) {
  return {
    ok: success,
    status: success ? 200 : 404,
    async json() {
      return { success, result, errors: success ? [] : result }
    },
  }
}

test('resolveCloudflareResources only reads the existing KV namespace', async () => {
  const calls = []
  const result = await resolveCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return response([{ id: '0123456789abcdef0123456789abcdef', title: 'airing-cal-kv' }])
    },
  })

  assert.equal(result.kvNamespaceId, '0123456789abcdef0123456789abcdef')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].init.method, undefined)
  assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test('resolveCloudflareResources tells operators to bootstrap missing resources', async () => {
  await assert.rejects(
    resolveCloudflareResources({
      env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
      fetchImpl: async () => response([]),
    }),
    /run the bootstrap workflow first/,
  )
})
