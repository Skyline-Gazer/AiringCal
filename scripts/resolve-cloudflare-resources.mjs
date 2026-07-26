import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'

const API_TIMEOUT_MS = 15_000

function requiredEnv(name, env) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function apiResponse(fetchImpl, token, path) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  const body = await response.json()
  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors) ? body.errors : []
    const message = errors.map((error) => `${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()).join('; ')
    throw new Error(message || `Cloudflare API request failed: ${response.status}`)
  }
  return body
}

function items(result, property) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.[property])) return result[property]
  if (Array.isArray(result?.result)) return result.result
  return []
}

function totalPages(resultInfo) {
  if (Number.isFinite(resultInfo?.total_pages)) return resultInfo.total_pages
  if (Number.isFinite(resultInfo?.total_count) && Number.isFinite(resultInfo?.per_page) && resultInfo.per_page > 0) {
    return Math.ceil(resultInfo.total_count / resultInfo.per_page)
  }
  return undefined
}

async function listAll(context, path, { property, query, pagination = 'page' } = {}) {
  const { fetchImpl, token } = context
  const collected = []
  let page = 1
  let cursor

  while (true) {
    const pageQuery = new URLSearchParams(query)
    if (pagination === 'cursor' && cursor) pageQuery.set('cursor', cursor)
    if (pagination === 'page' && page > 1) pageQuery.set('page', String(page))
    const response = await apiResponse(fetchImpl, token, `${path}${pageQuery.size > 0 ? `?${pageQuery}` : ''}`)
    collected.push(...items(response.result, property))

    if (pagination === 'cursor') {
      const nextCursor = response.result_info?.cursor
      if (typeof nextCursor !== 'string' || nextCursor.length === 0 || nextCursor === cursor) break
      cursor = nextCursor
      continue
    }

    const currentPage = Number.isFinite(response.result_info?.page) ? response.result_info.page : page
    const lastPage = totalPages(response.result_info)
    if (!Number.isFinite(lastPage) || currentPage >= lastPage) break
    page = currentPage + 1
  }

  return collected
}

function missingResource(name) {
  return new Error(`Cloudflare ${name} does not exist; run the bootstrap workflow first`)
}

export async function resolveCloudflareResources({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = requiredEnv('CLOUDFLARE_API_TOKEN', env)
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID', env)
  if (!fetchImpl) throw new Error('fetch is required')

  const context = { fetchImpl, token }
  const [databases, namespaces, r2Result, queues] = await Promise.all([
    listAll(context, `/accounts/${accountId}/d1/database`, {
      property: 'databases',
      query: new URLSearchParams({ per_page: '10000' }),
    }),
    listAll(context, `/accounts/${accountId}/storage/kv/namespaces`, {
      property: 'namespaces',
      query: new URLSearchParams({ per_page: '1000', order: 'title', direction: 'asc' }),
    }),
    listAll(context, `/accounts/${accountId}/r2/buckets`, {
      property: 'buckets',
      query: new URLSearchParams({ per_page: '1000' }),
      pagination: 'cursor',
    }),
    listAll(context, `/accounts/${accountId}/queues`, { property: 'queues' }),
  ])

  const database = databases.find((item) => item?.name === CLOUDFLARE_RESOURCES.d1DatabaseName)
  if (!database?.uuid) throw missingResource(`D1 database ${CLOUDFLARE_RESOURCES.d1DatabaseName}`)
  const namespace = namespaces.find((item) => item?.title === CLOUDFLARE_RESOURCES.kvNamespaceTitle)
  if (!namespace?.id) throw missingResource(`KV namespace ${CLOUDFLARE_RESOURCES.kvNamespaceTitle}`)
  const dataBucket = r2Result.find((item) => item?.name === CLOUDFLARE_RESOURCES.dataBucketName)
  if (!dataBucket) throw missingResource(`data R2 bucket ${CLOUDFLARE_RESOURCES.dataBucketName}`)
  const imageBucket = r2Result.find((item) => item?.name === CLOUDFLARE_RESOURCES.imageBucketName)
  if (!imageBucket) throw missingResource(`image R2 bucket ${CLOUDFLARE_RESOURCES.imageBucketName}`)
  for (const queueName of CLOUDFLARE_RESOURCES.queueNames) {
    if (!queues.some((item) => item?.queue_name === queueName || item?.name === queueName)) {
      throw missingResource(`Queue ${queueName}`)
    }
  }

  return {
    d1DatabaseId: database.uuid,
    kvNamespaceId: namespace.id,
    dataBucketName: CLOUDFLARE_RESOURCES.dataBucketName,
    imageBucketName: CLOUDFLARE_RESOURCES.imageBucketName,
    queueNames: CLOUDFLARE_RESOURCES.queueNames,
  }
}

async function main() {
  const result = await resolveCloudflareResources()
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `d1_database_id=${result.d1DatabaseId}\nkv_namespace_id=${result.kvNamespaceId}\n`)
  }
  console.log(`Resolved Cloudflare resources for ${result.dataBucketName}, ${result.imageBucketName}, ${result.queueNames.join(', ')}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
