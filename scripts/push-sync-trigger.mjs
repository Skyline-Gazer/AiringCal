import { pathToFileURL } from 'node:url'

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const queueName = process.env.SYNC_TRIGGER_QUEUE_NAME || 'airing-cal-sync-trigger'
const syncConsumerScriptName = process.env.SYNC_TRIGGER_CONSUMER_SCRIPT || 'airing-cal-sync'
const namespaceId = process.env.AIRING_CAL_KV_NAMESPACE_ID
const pollTimeoutMs = Number.parseInt(process.env.SYNC_TRIGGER_TIMEOUT_MS || '600000', 10)
const pollIntervalMs = Number.parseInt(process.env.SYNC_TRIGGER_POLL_INTERVAL_MS || '5000', 10)
const consumeTimeoutMs = Number.parseInt(process.env.SYNC_TRIGGER_CONSUME_TIMEOUT_MS || '60000', 10)
const summaryKey = 'snapshot:summary'
const calendarKey = 'snapshot:calendar'
const syncMetaKey = 'sync:meta'
const observableCommonImageStatuses = new Set(['queued', 'cached', 'failed', 'missing_source'])

export function syncSnapshotReady(summary) {
  return Boolean(summary && typeof summary === 'object' && Number.isFinite(summary._total) && summary._total > 0)
}

export function syncMetaFresh(meta, queuedAtMs) {
  const queuedAtSeconds = Math.floor(queuedAtMs / 1000)
  const syncedAt = Number.isFinite(meta?.calendar_synced_at) ? meta.calendar_synced_at : meta?.synced_at
  return Boolean(
    meta &&
    typeof meta === 'object' &&
    Number.isFinite(syncedAt) &&
    syncedAt >= queuedAtSeconds,
  )
}

export function syncMetaQueueStatus(meta) {
  const last = meta?.cron?.last
  if (!last || typeof last !== 'object') return null
  return last.source === 'queue' ? last : null
}

export function syncMetaQueueStatusFresh(meta, queuedAtMs) {
  const status = syncMetaQueueStatus(meta)
  const queuedAtSeconds = Math.floor(queuedAtMs / 1000)
  return Boolean(status && Number.isFinite(status.triggered_at) && status.triggered_at >= queuedAtSeconds)
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
  return observableCommonImageStatuses.has(status?.common?.status)
}

export function syncTriggerReady(summary, calendar, imageStatusesBySubject, meta, queuedAtMs) {
  if (!syncMetaFresh(meta, queuedAtMs)) return false
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

async function waitForSyncSnapshot(queuedAtMs) {
  const deadline = Date.now() + pollTimeoutMs
  const consumeDeadline = Date.now() + consumeTimeoutMs
  let lastSummary = null
  let lastCalendar = null
  let lastMeta = null
  let lastImageStatusesBySubject = new Map()
  while (Date.now() <= deadline) {
    ;[lastSummary, lastCalendar, lastMeta] = await Promise.all([
      kvJson(summaryKey),
      kvJson(calendarKey),
      kvJson(syncMetaKey),
    ])
    const subjectIds = calendarSubjectIds(lastCalendar)
    lastImageStatusesBySubject = new Map(await Promise.all(subjectIds.map(async (subjectId) => [
      subjectId,
      await kvJson(`image:status:${subjectId}`),
    ])))
    if (syncTriggerReady(lastSummary, lastCalendar, lastImageStatusesBySubject, lastMeta, queuedAtMs)) {
      console.log(`Fresh sync snapshot and calendar image pipeline status are ready: ${summaryKey} _total=${lastSummary._total}, calendar_subjects=${subjectIds.length}, synced_at=${lastMeta.synced_at}`)
      return
    }
    const queueStatus = syncMetaQueueStatus(lastMeta)
    if (syncMetaQueueStatusFresh(lastMeta, queuedAtMs) && queueStatus?.status === 'error') {
      throw new Error(`sync-worker queue trigger failed before publishing a fresh snapshot: ${JSON.stringify(queueStatus)}`)
    }
    if (!syncMetaQueueStatusFresh(lastMeta, queuedAtMs) && Date.now() > consumeDeadline) {
      throw new Error(`Timed out waiting for sync-worker queue consumer to start. Last meta: ${JSON.stringify(lastMeta)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  const readyCount = [...lastImageStatusesBySubject.values()].filter(calendarImageStatusReady).length
  throw new Error(`Timed out waiting for sync-worker/media-worker to publish fresh calendar image pipeline status. Last summary: ${JSON.stringify(lastSummary)}; last_meta=${JSON.stringify(lastMeta)}; calendar_subjects=${calendarSubjectIds(lastCalendar).length}; ready_common_status=${readyCount}`)
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

function queueDeliveryPaused(queue) {
  return queue?.settings?.delivery_paused === true
}

function consumersFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.items)) return result.items
  if (Array.isArray(result?.consumers)) return result.consumers
  return []
}

function syncConsumerBody() {
  return {
    script_name: syncConsumerScriptName,
    type: 'worker',
    settings: {
      batch_size: 1,
      max_wait_time_ms: 5000,
      max_retries: 3,
    },
  }
}

function consumerScriptName(consumer) {
  return consumer?.script_name ?? consumer?.script ?? ''
}

function isExpectedSyncConsumer(consumer) {
  return consumer?.type === 'worker' && consumerScriptName(consumer) === syncConsumerScriptName
}

export function syncConsumerNeedsUpdate(consumer) {
  const settings = consumer?.settings ?? {}
  return settings.batch_size !== 1 || settings.max_wait_time_ms !== 5000 || settings.max_retries !== 3
}

export async function ensureSyncConsumer(queueIdValue, apiImpl = api, accountIdValue = accountId, log = console.log) {
  const body = await apiImpl(`/accounts/${accountIdValue}/queues/${encodeURIComponent(queueIdValue)}/consumers`)
  const consumers = consumersFromResult(body.result)
  const expected = consumers.find(isExpectedSyncConsumer)
  const unexpected = consumers.filter((consumer) => !isExpectedSyncConsumer(consumer))
  if (unexpected.length) {
    throw new Error(`Queue ${queueName} already has unexpected consumers: ${JSON.stringify(unexpected)}`)
  }
  if (!expected) {
    await apiImpl(`/accounts/${accountIdValue}/queues/${encodeURIComponent(queueIdValue)}/consumers`, {
      method: 'POST',
      body: JSON.stringify(syncConsumerBody()),
    })
    log(`Attached ${syncConsumerScriptName} as consumer for ${queueName}`)
    return
  }
  if (syncConsumerNeedsUpdate(expected)) {
    if (!expected.consumer_id) throw new Error(`Queue ${queueName} consumer ${syncConsumerScriptName} is missing consumer_id`)
    await apiImpl(`/accounts/${accountIdValue}/queues/${encodeURIComponent(queueIdValue)}/consumers/${encodeURIComponent(expected.consumer_id)}`, {
      method: 'PUT',
      body: JSON.stringify(syncConsumerBody()),
    })
    log(`Updated ${syncConsumerScriptName} consumer settings for ${queueName}`)
  }
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
  if (queueDeliveryPaused(queue)) {
    throw new Error(`Cloudflare queue delivery is paused: ${queueName}`)
  }

  await ensureSyncConsumer(id)
  const queuedAtMs = Date.now()
  await api(`/accounts/${accountId}/queues/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      body: {
        type: 'deploy-sync',
        source: 'github-actions',
        ref: process.env.GITHUB_REF_NAME || null,
        sha: process.env.GITHUB_SHA || null,
        run_id: process.env.GITHUB_RUN_ID || null,
        queued_at: new Date(queuedAtMs).toISOString(),
      },
      content_type: 'json',
    }),
  })

  console.log(`Queued deploy sync trigger on ${queueName}`)
  await waitForSyncSnapshot(queuedAtMs)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
