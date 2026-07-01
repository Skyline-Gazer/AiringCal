import { pathToFileURL } from 'node:url'

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const queueName = process.env.SYNC_TRIGGER_QUEUE_NAME || 'airing-cal-sync-trigger'
const namespaceId = process.env.AIRING_CAL_KV_NAMESPACE_ID
const pollTimeoutMs = Number.parseInt(process.env.SYNC_TRIGGER_TIMEOUT_MS || '120000', 10)
const pollIntervalMs = Number.parseInt(process.env.SYNC_TRIGGER_POLL_INTERVAL_MS || '5000', 10)
const summaryKey = 'snapshot:summary'
const calendarKey = 'snapshot:calendar'
const terminalCommonImageStatuses = new Set(['cached', 'failed', 'missing_source'])

export function syncSnapshotReady(summary) {
  return Boolean(summary && typeof summary === 'object' && Number.isFinite(summary._total) && summary._total > 0)
}

export function calendarSubjectIds(calendar) {
  if (!Array.isArray(calendar)) return []
  const ids = []
  const seen = new Set()
  for (const day of calendar) {
    if (!Array.isArray(day?.items)) continue
    for (const item of day.items) {
      const id = typeof item?.subject_id === 'number' ? item.subject_id : item?.id
      if (typeof id !== 'number' || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

function calendarImageStatusReady(status) {
  return terminalCommonImageStatuses.has(status?.common?.status)
}

export function syncTriggerReady(summary, calendar, imageStatusesBySubject) {
  if (!syncSnapshotReady(summary)) return false
  const subjectIds = calendarSubjectIds(calendar)
  if (!subjectIds.length) return false
  for (const subjectId of subjectIds) {
    if (!calendarImageStatusReady(imageStatusesBySubject?.get(subjectId))) return false
  }
  return true
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
  let lastCalendar = null
  let lastImageStatusesBySubject = new Map()
  while (Date.now() <= deadline) {
    ;[lastSummary, lastCalendar] = await Promise.all([
      kvJson(summaryKey),
      kvJson(calendarKey),
    ])
    const subjectIds = calendarSubjectIds(lastCalendar)
    lastImageStatusesBySubject = new Map(await Promise.all(subjectIds.map(async (subjectId) => [
      subjectId,
      await kvJson(`image:status:${subjectId}`),
    ])))
    if (syncTriggerReady(lastSummary, lastCalendar, lastImageStatusesBySubject)) {
      console.log(`Sync snapshot and calendar image cache status are ready: ${summaryKey} _total=${lastSummary._total}, calendar_subjects=${subjectIds.length}`)
      return
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  const readyCount = [...lastImageStatusesBySubject.values()].filter(calendarImageStatusReady).length
  throw new Error(`Timed out waiting for sync-worker/media-worker to cache calendar images. Last summary: ${JSON.stringify(lastSummary)}; calendar_subjects=${calendarSubjectIds(lastCalendar).length}; ready_common_status=${readyCount}`)
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
