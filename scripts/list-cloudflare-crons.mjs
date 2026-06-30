import { pathToFileURL } from 'node:url'

const token = process.env.CLOUDFLARE_API_TOKEN
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
const targetWorker = process.env.CRON_TARGET_WORKER || 'airing-cal-sync'
const maxCronTriggers = Number.parseInt(process.env.CLOUDFLARE_MAX_CRON_TRIGGERS || '5', 10)

export function cronQuotaStatus(rows, workerName = targetWorker, limit = maxCronTriggers) {
  const targetHasCron = rows.some((row) => row.worker === workerName)
  return {
    count: rows.length,
    limit,
    targetWorker: workerName,
    targetHasCron,
    canDeployTargetCron: targetHasCron || rows.length < limit,
  }
}

async function api(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success === false) {
    const details = body ? JSON.stringify(body.errors ?? body, null, 2) : response.statusText
    throw new Error(`${response.status} ${response.statusText} ${path}\n${details}`)
  }
  return body
}

function servicesFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.items)) return result.items
  if (Array.isArray(result?.services)) return result.services
  return []
}

function serviceName(service) {
  return service.id ?? service.name ?? service.script_name ?? service.service ?? ''
}

function schedulesFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.schedules)) return result.schedules
  return []
}

async function main() {
  if (!token || !accountId) {
    console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required')
    process.exit(1)
  }

  const services = []
  for (let page = 1; ; page += 1) {
    const body = await api(`/accounts/${accountId}/workers/services?page=${page}&per_page=100`)
    services.push(...servicesFromResult(body.result))
    const totalPages = body.result_info?.total_pages ?? 1
    if (page >= totalPages) break
  }

  services.sort((a, b) => serviceName(a).localeCompare(serviceName(b)))

  const rows = []
  for (const service of services) {
    const name = serviceName(service)
    if (!name) continue
    const body = await api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/schedules`)
    for (const schedule of schedulesFromResult(body.result)) {
      rows.push({ worker: name, cron: schedule.cron })
    }
  }

  console.log('Cloudflare Worker Cron Triggers')
  if (!rows.length) {
    console.log('(none)')
  } else {
    for (const row of rows) {
      console.log(`- ${row.worker}: ${row.cron}`)
    }
  }
  console.log(`Total cron triggers: ${rows.length}`)

  const quota = cronQuotaStatus(rows)
  if (!quota.canDeployTargetCron) {
    console.error(`Cloudflare account cron trigger quota is full for the current plan, and ${quota.targetWorker} does not already have a reusable cron trigger.`)
    process.exit(2)
  }
  if (quota.count >= quota.limit) {
    console.log(`Cron trigger quota is full, but ${quota.targetWorker} already owns a trigger, so this deploy can update the existing schedule.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
