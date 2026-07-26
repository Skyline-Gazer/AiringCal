import assert from 'node:assert/strict'
import test from 'node:test'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'
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

test('provisionCloudflareResources creates fixed resources once and reuses their D1 id', async () => {
  const requests = []
  const databases = []
  const namespaces = []
  const buckets = []
  const queues = []
  const d1DatabaseId = '11111111-1111-4111-8111-111111111111'
  const expectedInitialCreates = 5
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method, body: init.body })
    if (url.includes('/d1/database')) {
      if (init.method === 'POST') {
        const database = { uuid: d1DatabaseId, name: JSON.parse(init.body).name }
        databases.push(database)
        return jsonResponse(database)
      }
      return jsonResponse(databases)
    }
    if (url.includes('/storage/kv/namespaces')) {
      if (init.method === 'POST') {
        const namespace = { id: 'kv-id', title: JSON.parse(init.body).title }
        namespaces.push(namespace)
        return jsonResponse(namespace)
      }
      return jsonResponse(namespaces)
    }
    if (url.includes('/r2/buckets')) {
      if (init.method === 'POST') {
        const bucket = { name: JSON.parse(init.body).name }
        buckets.push(bucket)
        return jsonResponse(bucket)
      }
      return jsonResponse({ buckets })
    }
    if (url.includes('/queues')) {
      if (init.method === 'POST') {
        const queue = { queue_name: JSON.parse(init.body).queue_name }
        queues.push(queue)
        return jsonResponse(queue)
      }
      return jsonResponse(queues)
    }
    throw new Error(`unexpected URL ${url}`)
  }
  const options = {
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  }

  const first = await provisionCloudflareResources(options)
  const second = await provisionCloudflareResources(options)

  assert.deepEqual(CLOUDFLARE_RESOURCES, {
    d1DatabaseName: 'airing-cal-state',
    dataBucketName: 'airing-cal-data',
    imageBucketName: 'airing-cal-images',
    kvNamespaceTitle: 'airing-cal-kv',
    queueNames: ['airing-cal-media'],
  })
  assert.equal(first.d1DatabaseId, d1DatabaseId)
  assert.equal(second.d1DatabaseId, first.d1DatabaseId)
  assert.deepEqual(first, {
    d1DatabaseId,
    d1DatabaseName: 'airing-cal-state',
    dataBucketName: 'airing-cal-data',
    imageBucketName: 'airing-cal-images',
    kvNamespaceId: 'kv-id',
    queueNames: ['airing-cal-media'],
  })
  assert.equal(requests.filter((request) => request.method === 'POST').length, expectedInitialCreates)
})

test('provisionCloudflareResources re-lists D1 after an already-exists race', async () => {
  const d1DatabaseId = '11111111-1111-4111-8111-111111111111'
  let d1ListCalls = 0
  const fetchImpl = async (url, init = {}) => {
    if (url.includes('/d1/database')) {
      if (init.method === 'POST') return jsonResponse([{ code: 10014, message: 'database already exists' }], false)
      d1ListCalls += 1
      return jsonResponse(d1ListCalls === 1 ? [] : [{ uuid: d1DatabaseId, name: 'airing-cal-state' }])
    }
    if (url.includes('/storage/kv/namespaces')) return jsonResponse([{ id: 'kv-id', title: 'airing-cal-kv' }])
    if (url.includes('/r2/buckets')) return jsonResponse({ buckets: [{ name: 'airing-cal-data' }, { name: 'airing-cal-images' }] })
    if (url.includes('/queues')) return jsonResponse([{ queue_name: 'airing-cal-media' }])
    throw new Error(`unexpected URL ${url}`)
  }

  const result = await provisionCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  })

  assert.equal(result.d1DatabaseId, d1DatabaseId)
  assert.equal(d1ListCalls, 2)
})
