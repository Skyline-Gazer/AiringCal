import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const KV_NAMESPACE_TITLE = 'airing-cal-kv'
const API_TIMEOUT_MS = 15_000

function requiredEnv(name, env) {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export async function resolveCloudflareResources({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const token = requiredEnv('CLOUDFLARE_API_TOKEN', env)
  const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID', env)
  const query = new URLSearchParams({ per_page: '1000', order: 'title', direction: 'asc' })
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?${query}`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    },
  )
  const body = await response.json()
  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors) ? body.errors : []
    const message = errors.map((error) => `${error.code ?? 'unknown'} ${error.message ?? ''}`.trim()).join('; ')
    throw new Error(message || `Cloudflare API request failed: ${response.status}`)
  }
  const namespace = (Array.isArray(body.result) ? body.result : []).find((item) => item?.title === KV_NAMESPACE_TITLE)
  if (!namespace?.id) {
    throw new Error(`Cloudflare KV namespace ${KV_NAMESPACE_TITLE} does not exist; run the bootstrap workflow first`)
  }
  return { kvNamespaceId: namespace.id, kvNamespaceTitle: KV_NAMESPACE_TITLE }
}

async function main() {
  const result = await resolveCloudflareResources()
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `kv_namespace_id=${result.kvNamespaceId}\n`)
  }
  console.log(`Resolved Cloudflare KV namespace ${result.kvNamespaceTitle}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
