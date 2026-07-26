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

function existingResources({ missing } = {}) {
  return async (url, init = {}) => {
    if (url.includes('/d1/database')) {
      return response(missing === 'D1 database' ? [] : [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'airing-cal-state' }])
    }
    if (url.includes('/storage/kv/namespaces')) {
      return response(missing === 'KV namespace' ? [] : [{ id: '0123456789abcdef0123456789abcdef', title: 'airing-cal-kv' }])
    }
    if (url.includes('/r2/buckets')) {
      const buckets = [
        ...(missing === 'data R2 bucket' ? [] : [{ name: 'airing-cal-data' }]),
        ...(missing === 'image R2 bucket' ? [] : [{ name: 'airing-cal-images' }]),
      ]
      return response({ buckets })
    }
    if (url.includes('/queues')) {
      return response(missing === 'Queue' ? [] : [{ queue_name: 'airing-cal-media' }])
    }
    throw new Error(`unexpected URL ${url}`)
  }
}

test('resolveCloudflareResources only reads all existing compatibility resources', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return existingResources()(url, init)
  }

  const result = await resolveCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  })

  assert.deepEqual(result, {
    d1DatabaseId: '11111111-1111-4111-8111-111111111111',
    kvNamespaceId: '0123456789abcdef0123456789abcdef',
    dataBucketName: 'airing-cal-data',
    imageBucketName: 'airing-cal-images',
    queueNames: ['airing-cal-media'],
  })
  assert.equal(calls.length, 4)
  assert.equal(calls.every((call) => call.init.method === undefined), true)
  assert.equal(calls.every((call) => call.init.signal instanceof AbortSignal), true)
})

for (const missing of ['D1 database', 'KV namespace', 'data R2 bucket', 'image R2 bucket', 'Queue']) {
  test(`resolveCloudflareResources tells operators to bootstrap a missing ${missing}`, async () => {
    await assert.rejects(
      resolveCloudflareResources({
        env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
        fetchImpl: existingResources({ missing }),
      }),
      /run the bootstrap workflow first$/,
    )
  })
}
