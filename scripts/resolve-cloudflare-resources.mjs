import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

import { CLOUDFLARE_RESOURCES } from './cloudflare-resource-contract.mjs'

const API_TIMEOUT_MS = 15_000

function requiredEnv(name, env) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function apiRequest(fetchImpl, token, path) {
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
  return body.result
}

function items(result, property) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.[property])) return result[property]
  if (Array.isArray(result?.result)) return result.result
  return []
}

function missingResource(name) {
  return new Error(`Cloudflare ${name} does not exist; run the bootstrap workflow first`)
}

export async function resolveCloudflareResources({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = requiredEnv('CLOUDFLARE_API_TOKEN', env)
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID', env)
  if (!fetchImpl) throw new Error('fetch is required')

  const query = new URLSearchParams({ per_page: '1000', order: 'title', direction: 'asc' })
  const [databases, namespaces, r2Result, queues] = await Promise.all([
    apiRequest(fetchImpl, token, `/accounts/${accountId}/d1/database`),
    apiRequest(fetchImpl, token, `/accounts/${accountId}/storage/kv/namespaces?${query}`),
    apiRequest(fetchImpl, token, `/accounts/${accountId}/r2/buckets`),
    apiRequest(fetchImpl, token, `/accounts/${accountId}/queues`),
  ])

  const database = items(databases, 'databases').find((item) => item?.name === CLOUDFLARE_RESOURCES.d1DatabaseName)
  if (!database?.uuid) throw missingResource(`D1 database ${CLOUDFLARE_RESOURCES.d1DatabaseName}`)
  const namespace = items(namespaces, 'namespaces').find((item) => item?.title === CLOUDFLARE_RESOURCES.kvNamespaceTitle)
  if (!namespace?.id) throw missingResource(`KV namespace ${CLOUDFLARE_RESOURCES.kvNamespaceTitle}`)
  const buckets = items(r2Result, 'buckets')
  const dataBucket = buckets.find((item) => item?.name === CLOUDFLARE_RESOURCES.dataBucketName)
  if (!dataBucket) throw missingResource(`data R2 bucket ${CLOUDFLARE_RESOURCES.dataBucketName}`)
  const imageBucket = buckets.find((item) => item?.name === CLOUDFLARE_RESOURCES.imageBucketName)
  if (!imageBucket) throw missingResource(`image R2 bucket ${CLOUDFLARE_RESOURCES.imageBucketName}`)
  for (const queueName of CLOUDFLARE_RESOURCES.queueNames) {
    if (!items(queues, 'queues').some((item) => item?.queue_name === queueName || item?.name === queueName)) {
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
