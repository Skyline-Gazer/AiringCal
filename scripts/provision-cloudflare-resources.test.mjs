import assert from 'node:assert/strict'
import test from 'node:test'

import { provisionCloudflareResources } from './provision-cloudflare-resources.mjs'

function jsonResponse(result, success = true) {
  return {
    ok: success,
    status: success ? 200 : 400,
    async json() {
      return { success, result, errors: success ? [] : result }
    },
  }
}

test('provisionCloudflareResources reuses existing Cloudflare resources', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes('/storage/kv/namespaces')) return jsonResponse([{ id: 'kv-id', title: 'airing-cal-kv' }])
    if (url.includes('/r2/buckets')) return jsonResponse({ buckets: [{ name: 'airing-cal-images' }] })
    if (url.includes('/queues')) {
      return jsonResponse([
        { queue_name: 'airing-cal-media' },
        { queue_name: 'airing-cal-sync-trigger' },
      ])
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const result = await provisionCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  })

  assert.equal(result.kvNamespaceId, 'kv-id')
  assert.equal(calls.every((call) => call.init.method !== 'POST'), true)
})

test('provisionCloudflareResources creates missing resources and returns the KV namespace id', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.includes('/storage/kv/namespaces')) {
      if (init.method === 'POST') return jsonResponse({ id: 'created-kv-id', title: 'airing-cal-kv' })
      return jsonResponse([])
    }
    if (url.includes('/r2/buckets')) {
      if (init.method === 'POST') return jsonResponse({ name: 'airing-cal-images' })
      return jsonResponse({ buckets: [] })
    }
    if (url.includes('/queues')) {
      if (init.method === 'POST') return jsonResponse({ queue_name: JSON.parse(init.body).queue_name })
      return jsonResponse([])
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const result = await provisionCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  })

  assert.equal(result.kvNamespaceId, 'created-kv-id')
  const postBodies = calls.filter((call) => call.init.method === 'POST').map((call) => JSON.parse(call.init.body))
  assert.deepEqual(postBodies, [
    { title: 'airing-cal-kv' },
    { name: 'airing-cal-images' },
    { queue_name: 'airing-cal-media' },
    { queue_name: 'airing-cal-sync-trigger' },
  ])
})
