const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const queueName = process.env.SYNC_TRIGGER_QUEUE_NAME || 'airing-cal-sync-trigger'

if (!token || !accountId) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required')
  process.exit(1)
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
