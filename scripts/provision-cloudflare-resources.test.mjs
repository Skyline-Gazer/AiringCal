import assert from 'node:assert/strict'
import test from 'node:test'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'
import { provisionCloudflareResources } from './provision-cloudflare-resources.mjs'

function jsonResponse(result, success = true, resultInfo) {
  return {
    ok: success,
    status: success ? 200 : 400,
    async json() {
      return { success, result, result_info: resultInfo, errors: success ? [] : result }
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

test('provisionCloudflareResources replays without creates when resources are on later pages and cursors', async () => {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method })
    if (init.method === 'POST') throw new Error(`unexpected create ${url}`)
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/d1/database')) {
      if (parsed.searchParams.get('page') === '2') {
        return jsonResponse(
          [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'airing-cal-state' }],
          true,
          { page: 2, per_page: 1, total_count: 2 },
        )
      }
      return jsonResponse([{ uuid: 'other-d1', name: 'other-database' }], true, { page: 1, per_page: 1, total_count: 2 })
    }
    if (parsed.pathname.endsWith('/storage/kv/namespaces')) {
      if (parsed.searchParams.get('page') === '2') {
        return jsonResponse(
          [{ id: 'kv-id', title: 'airing-cal-kv' }],
          true,
          { page: 2, per_page: 1, total_count: 2 },
        )
      }
      return jsonResponse([{ id: 'other-kv', title: 'other-kv' }], true, { page: 1, per_page: 1, total_count: 2 })
    }
    if (parsed.pathname.endsWith('/r2/buckets')) {
      if (parsed.searchParams.get('cursor') === 'r2-next') {
        return jsonResponse({ buckets: [{ name: 'airing-cal-data' }, { name: 'airing-cal-images' }] }, true, {})
      }
      return jsonResponse({ buckets: [{ name: 'other-bucket' }] }, true, { cursor: 'r2-next', per_page: 1 })
    }
    if (parsed.pathname.endsWith('/queues')) {
      if (parsed.searchParams.get('page') === '2') {
        return jsonResponse([{ queue_name: 'airing-cal-media' }], true, { page: 2, per_page: 1, total_pages: 2 })
      }
      return jsonResponse([{ queue_name: 'other-queue' }], true, { page: 1, per_page: 1, total_pages: 2 })
    }
    throw new Error(`unexpected URL ${url}`)
  }
  const options = {
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  }

  const first = await provisionCloudflareResources(options)
  const second = await provisionCloudflareResources(options)

  assert.equal(first.d1DatabaseId, '11111111-1111-4111-8111-111111111111')
  assert.deepEqual(second, first)
  assert.equal(requests.some((request) => new URL(request.url).searchParams.get('page') === '2'), true)
  assert.equal(requests.some((request) => new URL(request.url).searchParams.get('cursor') === 'r2-next'), true)
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0)
})

test('provisionCloudflareResources re-lists complete collections after already-exists races', async () => {
  const created = new Set()
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method })
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/d1/database')) {
      if (init.method === 'POST') {
        created.add('d1')
        return jsonResponse([{ code: 10014, message: 'database already exists' }], false)
      }
      const page = parsed.searchParams.get('page')
      const result = page === '2' && created.has('d1')
        ? [{ uuid: '11111111-1111-4111-8111-111111111111', name: 'airing-cal-state' }]
        : [{ uuid: 'other-d1', name: 'other-database' }]
      return jsonResponse(result, true, { page: Number(page ?? 1), per_page: 1, total_pages: 2 })
    }
    if (parsed.pathname.endsWith('/storage/kv/namespaces')) {
      if (init.method === 'POST') {
        created.add('kv')
        return jsonResponse([{ code: 10014, message: 'namespace already exists' }], false)
      }
      const page = parsed.searchParams.get('page')
      const result = page === '2' && created.has('kv')
        ? [{ id: 'kv-id', title: 'airing-cal-kv' }]
        : [{ id: 'other-kv', title: 'other-kv' }]
      return jsonResponse(result, true, { page: Number(page ?? 1), per_page: 1, total_pages: 2 })
    }
    if (parsed.pathname.endsWith('/r2/buckets')) {
      if (init.method === 'POST') {
        created.add(JSON.parse(init.body).name)
        return jsonResponse([{ code: 10014, message: 'bucket already exists' }], false)
      }
      const isSecondPage = parsed.searchParams.get('cursor') === 'r2-next'
      const buckets = isSecondPage ? [...created].filter((name) => name.startsWith('airing-cal-')).map((name) => ({ name })) : [{ name: 'other-bucket' }]
      return jsonResponse({ buckets }, true, isSecondPage ? {} : { cursor: 'r2-next', per_page: 1 })
    }
    if (parsed.pathname.endsWith('/queues')) {
      if (init.method === 'POST') {
        created.add('queue')
        return jsonResponse([{ code: 10014, message: 'queue already exists' }], false)
      }
      const page = parsed.searchParams.get('page')
      const result = page === '2' && created.has('queue') ? [{ queue_name: 'airing-cal-media' }] : [{ queue_name: 'other-queue' }]
      return jsonResponse(result, true, { page: Number(page ?? 1), per_page: 1, total_pages: 2 })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const result = await provisionCloudflareResources({
    env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ACCOUNT_ID: 'account' },
    fetchImpl,
  })

  assert.equal(result.d1DatabaseId, '11111111-1111-4111-8111-111111111111')
  for (const suffix of ['/d1/database', '/storage/kv/namespaces', '/r2/buckets', '/queues']) {
    const postIndex = requests.findIndex((request) => request.url.includes(suffix) && request.method === 'POST')
    assert.notEqual(postIndex, -1)
    assert.equal(requests.slice(postIndex + 1).some((request) => request.url.includes(suffix) && request.method === undefined), true)
  }
})
