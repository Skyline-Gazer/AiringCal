import { readFileSync } from 'node:fs'
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

/** @param {string} wranglerToml */
export function parseWranglerCronDeploy(wranglerToml) {
  const nameMatch = wranglerToml.match(/^name\s*=\s*"([^"]+)"/m)
  if (!nameMatch) {
    throw new Error('wrangler.toml is missing name = "..."')
  }
  const triggersBlock = wranglerToml.match(/^\[triggers\][\s\S]*?^crons\s*=\s*(\[[^\]]*\])/m)
  let crons = []
  if (triggersBlock) {
    try {
      crons = JSON.parse(triggersBlock[1].replace(/'/g, '"'))
    } catch {
      throw new Error('wrangler.toml [triggers].crons is not valid JSON array')
    }
  }
  if (!Array.isArray(crons)) {
    throw new Error('wrangler.toml [triggers].crons must be an array')
  }
  return { worker: nameMatch[1], crons }
}

/**
 * Apply planned Wrangler uploads so preflight matches post-deploy cron occupancy.
 * @param {{ worker: string, cron: string }[]} accountRows
 * @param {{ worker: string, crons: string[] }[]} deployPlans
 */
export function projectCronRowsAfterDeploy(accountRows, deployPlans) {
  const planByWorker = new Map(deployPlans.map((plan) => [plan.worker, plan.crons]))
  const untouched = accountRows.filter((row) => !planByWorker.has(row.worker))
  const projected = [...untouched]
  for (const plan of deployPlans) {
    for (const cron of plan.crons) {
      projected.push({ worker: plan.worker, cron })
    }
  }
  return projected
}

function deployPlansFromArgv(argv) {
  /** @type {{ worker: string, crons: string[] }[]} */
  const plans = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--deploy') {
      const path = argv[index + 1]
      if (!path) throw new Error('--deploy requires a wrangler.toml path')
      plans.push(parseWranglerCronDeploy(readFileSync(path, 'utf8')))
      index += 1
    }
  }
  return plans
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

  const deployPlans = deployPlansFromArgv(process.argv.slice(2))

  const services = []
  for (let page = 1; ; page += 1) {
    const body = await api(`/accounts/${accountId}/workers/services?page=${page}&per_page=100`)
    services.push(...servicesFromResult(body.result))
    const totalPages = body.result_info?.total_pages ?? 1
    if (page >= totalPages) break
  }

  services.sort((a, b) => serviceName(a).localeCompare(serviceName(b)))

  const accountRows = []
  for (const service of services) {
    const name = serviceName(service)
    if (!name) continue
    const body = await api(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(name)}/schedules`)
    for (const schedule of schedulesFromResult(body.result)) {
      accountRows.push({ worker: name, cron: schedule.cron })
    }
  }

  const rows = deployPlans.length > 0
    ? projectCronRowsAfterDeploy(accountRows, deployPlans)
    : accountRows

  console.log('Cloudflare Worker Cron Triggers')
  if (deployPlans.length > 0) {
    console.log(`(projected after deploy: ${deployPlans.map((plan) => plan.worker).join(', ')})`)
  }
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
