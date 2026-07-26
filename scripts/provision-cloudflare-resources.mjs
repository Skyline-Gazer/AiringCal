import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'

const API_TIMEOUT_MS = 15_000

function requiredEnv(name, env = process.env) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function apiRequest(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const body = await response.json()
  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors) ? body.errors : []
    const message = errors.map((error) => `${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()).join('; ')
    const apiError = new Error(message || `Cloudflare API request failed: ${response.status}`)
    apiError.errors = errors
    throw apiError
  }
  return body.result
}

function findByName(items, names, expected) {
  return items.find((item) => names.some((name) => item?.[name] === expected))
}

function d1Databases(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.databases)) return result.databases
  if (Array.isArray(result?.result)) return result.result
  return []
}

async function ensureD1Database(context, name) {
  const { fetchImpl, token, accountId } = context
  const list = async () => d1Databases(await apiRequest(fetchImpl, token, `/accounts/${accountId}/d1/database`))
  const existing = findByName(await list(), ['name'], name)
  if (existing?.uuid) return existing

  try {
    return await apiRequest(fetchImpl, token, `/accounts/${accountId}/d1/database`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  } catch (error) {
    if (error.errors?.some((item) => item.code === 10014 || /already exists/i.test(item.message ?? ''))) {
      const createdByRace = findByName(await list(), ['name'], name)
      if (createdByRace?.uuid) return createdByRace
    }
    throw error
  }
}

async function ensureKvNamespace(context, title) {
  const { fetchImpl, token, accountId } = context
  const query = new URLSearchParams({ per_page: '1000', order: 'title', direction: 'asc' })
  const list = async () => apiRequest(fetchImpl, token, `/accounts/${accountId}/storage/kv/namespaces?${query}`)
  const existing = findByName(await list(), ['title'], title)
  if (existing?.id) return existing

  try {
    return await apiRequest(fetchImpl, token, `/accounts/${accountId}/storage/kv/namespaces`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
  } catch (error) {
    if (error.errors?.some((item) => item.code === 10014)) {
      const createdByRace = findByName(await list(), ['title'], title)
      if (createdByRace?.id) return createdByRace
    }
    throw error
  }
}

async function ensureR2Bucket(context, name) {
  const { fetchImpl, token, accountId } = context
  const listResult = await apiRequest(fetchImpl, token, `/accounts/${accountId}/r2/buckets`)
  const buckets = Array.isArray(listResult) ? listResult : listResult?.buckets ?? []
  const existing = findByName(buckets, ['name'], name)
  if (existing) return existing

  try {
    return await apiRequest(fetchImpl, token, `/accounts/${accountId}/r2/buckets`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  } catch (error) {
    if (error.errors?.some((item) => /already exists/i.test(item.message ?? ''))) return { name }
    throw error
  }
}

async function ensureQueue(context, queueName) {
  const { fetchImpl, token, accountId } = context
  const listResult = await apiRequest(fetchImpl, token, `/accounts/${accountId}/queues`)
  const queues = Array.isArray(listResult) ? listResult : listResult?.queues ?? []
  const existing = findByName(queues, ['queue_name', 'name'], queueName)
  if (existing) return existing

  try {
    return await apiRequest(fetchImpl, token, `/accounts/${accountId}/queues`, {
      method: 'POST',
      body: JSON.stringify({ queue_name: queueName }),
    })
  } catch (error) {
    if (error.errors?.some((item) => /already exists/i.test(item.message ?? ''))) return { queue_name: queueName }
    throw error
  }
}

export async function provisionCloudflareResources({
  env = process.env,
  fetchImpl = globalThis.fetch,
  resources = CLOUDFLARE_RESOURCES,
} = {}) {
  const token = requiredEnv('CLOUDFLARE_API_TOKEN', env)
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID', env)
  if (!fetchImpl) throw new Error('fetch is required')

  const context = { fetchImpl, token, accountId }
  const database = await ensureD1Database(context, resources.d1DatabaseName)
  if (!database?.uuid) throw new Error(`D1 database ${resources.d1DatabaseName} did not return a uuid`)
  const namespace = await ensureKvNamespace(context, resources.kvNamespaceTitle)
  if (!namespace?.id) throw new Error(`KV namespace ${resources.kvNamespaceTitle} did not return an id`)
  await ensureR2Bucket(context, resources.dataBucketName)
  await ensureR2Bucket(context, resources.imageBucketName)
  for (const queueName of resources.queueNames) {
    await ensureQueue(context, queueName)
  }
  return {
    d1DatabaseId: database.uuid,
    d1DatabaseName: resources.d1DatabaseName,
    dataBucketName: resources.dataBucketName,
    imageBucketName: resources.imageBucketName,
    kvNamespaceId: namespace.id,
    queueNames: resources.queueNames,
  }
}

async function main() {
  const result = await provisionCloudflareResources()
  const lines = [
    `AIRING_CAL_D1_DATABASE_ID=${result.d1DatabaseId}`,
    `AIRING_CAL_KV_NAMESPACE_ID=${result.kvNamespaceId}`,
  ]
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, `${lines.join('\n')}\n`)
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `d1_database_id=${result.d1DatabaseId}\nkv_namespace_id=${result.kvNamespaceId}\n`)
  }
  console.log(`Provisioned Cloudflare resources for ${result.d1DatabaseName}, ${result.dataBucketName}, ${result.imageBucketName}, ${result.queueNames.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
