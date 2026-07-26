import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCloudflareResources } from './resolve-cloudflare-resources.mjs'

function response(result, success = true, resultInfo) {
  return {
    ok: success,
    status: success ? 200 : 404,
    async json() {
      return { success, result, result_info: resultInfo, errors: success ? [] : result }
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

test('resolveCloudflareResources finds resources on later pages and cursors', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/d1/database')) {
      if (parsed.searchParams.get('page') === '2') {
        return response(
          [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'airing-cal-state' }],
          true,
          { page: 2, per_page: 1, total_count: 2 },
        )
      }
      return response([{ uuid: 'other-d1', name: 'other-database' }], true, { page: 1, per_page: 1, total_count: 2 })
    }
    if (parsed.pathname.endsWith('/storage/kv/namespaces')) {
      if (parsed.searchParams.get('page') === '2') {
        return response(
          [{ id: '0123456789abcdef0123456789abcdef', title: 'airing-cal-kv' }],
          true,
          { page: 2, per_page: 1, total_count: 2 },
        )
      }
      return response([{ id: 'other-kv', title: 'other-kv' }], true, { page: 1, per_page: 1, total_count: 2 })
    }
    if (parsed.pathname.endsWith('/r2/buckets')) {
      if (parsed.searchParams.get('cursor') === 'r2-next') {
        return response({ buckets: [{ name: 'airing-cal-data' }, { name: 'airing-cal-images' }] }, true, {})
      }
      return response({ buckets: [{ name: 'other-bucket' }] }, true, { cursor: 'r2-next', per_page: 1 })
    }
    if (parsed.pathname.endsWith('/queues')) {
      if (parsed.searchParams.get('page') === '2') {
        return response([{ queue_name: 'airing-cal-media' }], true, { page: 2, per_page: 1, total_pages: 2 })
      }
      return response([{ queue_name: 'other-queue' }], true, { page: 1, per_page: 1, total_pages: 2 })
    }
    throw new Error(`unexpected URL ${url}`)
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
  assert.equal(calls.some((url) => new URL(url).searchParams.get('page') === '2'), true)
  assert.equal(calls.some((url) => new URL(url).searchParams.get('cursor') === 'r2-next'), true)
})
