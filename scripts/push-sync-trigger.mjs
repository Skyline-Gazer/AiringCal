import { pathToFileURL } from 'node:url'

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const queueName = process.env.SYNC_TRIGGER_QUEUE_NAME || 'airing-cal-sync-trigger'
const namespaceId = process.env.AIRING_CAL_KV_NAMESPACE_ID
const pollTimeoutMs = Number.parseInt(process.env.SYNC_TRIGGER_TIMEOUT_MS || '120000', 10)
const pollIntervalMs = Number.parseInt(process.env.SYNC_TRIGGER_POLL_INTERVAL_MS || '5000', 10)
const summaryKey = 'snapshot:summary'

export function syncSnapshotReady(summary) {
  return Boolean(summary && typeof summary === 'object' && Number.isFinite(summary._total) && summary._total > 0)
}

async function api(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    const details = body ? JSON.stringify(body.errors ?? body, null, 2) : response.statusText
    throw new Error(`${response.status} ${response.statusText} ${path}\n${details}`)
  }
  return body
}

async function kvJson(key) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
  if (response.status === 404) return null
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} KV ${key}\n${text}`)
  }
  return JSON.parse(text)
}

async function waitForSyncSnapshot() {
  const deadline = Date.now() + pollTimeoutMs
  let lastSummary = null
  while (Date.now() <= deadline) {
    lastSummary = await kvJson(summaryKey)
    if (syncSnapshotReady(lastSummary)) {
      console.log(`Sync snapshot is ready: ${summaryKey} _total=${lastSummary._total}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new Error(`Timed out waiting for sync-worker to write non-empty ${summaryKey}. Last value: ${JSON.stringify(lastSummary)}`)
}

function queuesFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.items)) return result.items
  if (Array.isArray(result?.queues)) return result.queues
  return []
}

function queueId(queue) {
  return queue.queue_id ?? queue.id ?? ''
}

function queueTitle(queue) {
  return queue.queue_name ?? queue.name ?? ''
}

async function main() {
  if (!token || !accountId || !namespaceId) {
    console.error('CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and AIRING_CAL_KV_NAMESPACE_ID are required')
    process.exit(1)
  }

  const queuesBody = await api(`/accounts/${accountId}/queues`)
  const queue = queuesFromResult(queuesBody.result).find((item) => queueTitle(item) === queueName)
  const id = queue ? queueId(queue) : ''

  if (!id) {
    console.error(`Cloudflare queue not found: ${queueName}`)
    process.exit(1)
  }

  await api(`/accounts/${accountId}/queues/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'deploy-sync',
        source: 'github-actions',
        ref: process.env.GITHUB_REF_NAME || null,
        sha: process.env.GITHUB_SHA || null,
        run_id: process.env.GITHUB_RUN_ID || null,
        queued_at: new Date().toISOString(),
      },
      content_type: 'json',
    }),
  })

  console.log(`Queued deploy sync trigger on ${queueName}`)
  await waitForSyncSnapshot()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
