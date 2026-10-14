const MAX_BATCH = 50

export interface ThumbGenClientConfig {
  url: string
  bearer: string
}

export type ThumbGenConfigState = 'ready' | 'disabled' | 'missing_bearer' | 'missing_url'

function resolveThumbGenUrl(env: Record<string, string | undefined>): string {
  const explicit = env.AIRINGCAL_THUMB_GEN_URL?.trim()
  if (explicit) return explicit
  const origin = env.AIRINGCAL_WEB_ORIGIN?.trim()
  if (!origin) return ''
  return `${origin.replace(/\/$/, '')}/api/thumb-gen`
}

export function describeThumbGenConfig(env: Record<string, string | undefined>): {
  state: ThumbGenConfigState
  url_present: boolean
  bearer_present: boolean
} {
  const url = resolveThumbGenUrl(env)
  const bearer = env.AIRINGCAL_THUMB_GEN_BEARER?.trim() ?? ''
  const urlPresent = Boolean(url)
  const bearerPresent = Boolean(bearer)
  if (!urlPresent && !bearerPresent) {
    return { state: 'disabled', url_present: false, bearer_present: false }
  }
  if (!urlPresent) {
    return { state: 'missing_url', url_present: false, bearer_present: bearerPresent }
  }
  if (!bearerPresent) {
    return { state: 'missing_bearer', url_present: true, bearer_present: false }
  }
  return { state: 'ready', url_present: true, bearer_present: true }
}

export function resolveThumbGenConfig(env: Record<string, string | undefined>): ThumbGenClientConfig | null {
  const cfg = describeThumbGenConfig(env)
  if (cfg.state !== 'ready') return null
  return { url: resolveThumbGenUrl(env), bearer: env.AIRINGCAL_THUMB_GEN_BEARER!.trim() }
}

/** Sync-tail visibility: config, account large count, and operator hints (cron / manual POST). */
export function logThumbGenSyncTail(options: {
  env: Record<string, string | undefined>
  large_persisted_this_run: number
  account_large_count: number
}): void {
  const cfg = describeThumbGenConfig(options.env)
  const persisted = options.large_persisted_this_run
  const accountLarge = options.account_large_count
  const base = {
    stage: 'thumb_gen_tail',
    trigger_config: cfg.state,
    large_persisted_this_run: persisted,
    account_large_count: accountLarge,
  }

  if (cfg.state === 'ready') {
    if (persisted > 0) {
      console.log(JSON.stringify({
        status: 'info',
        ...base,
        message: 'new large(s) persisted; async thumb_gen_trigger expected below',
      }))
      return
    }
    if (accountLarge > 0) {
      console.log(JSON.stringify({
        status: 'info',
        ...base,
        message: 'no new large this run; existing larges may lack thumb until Worker cron or manual POST /api/thumb-gen with large_hashes',
      }))
      return
    }
    console.log(JSON.stringify({ status: 'info', ...base, message: 'no large images in D1 yet' }))
    return
  }

  if (persisted > 0) {
    const detail = cfg.state === 'missing_bearer'
      ? 'AIRINGCAL_THUMB_GEN_BEARER missing'
      : 'thumb-gen URL not configured (set AIRINGCAL_THUMB_GEN_URL or AIRINGCAL_WEB_ORIGIN)'
    console.log(JSON.stringify({
      status: 'warn',
      ...base,
      message: `new large(s) persisted but thumb-gen not triggered: ${detail}`,
    }))
    return
  }

  if (accountLarge > 0 && cfg.state !== 'disabled') {
    console.log(JSON.stringify({
      status: 'warn',
      ...base,
      message: 'account has larges but thumb-gen env incomplete; sync will not POST until URL and bearer are set',
    }))
    return
  }

  if (accountLarge > 0 && cfg.state === 'disabled') {
    console.log(JSON.stringify({
      status: 'info',
      ...base,
      message: 'thumb pipeline disabled; UI serves large JPEG until AIRINGCAL_THUMB_GEN_* or WEB_ORIGIN+bearer configured',
    }))
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

export async function postThumbGenBatch(
  hashes: string[],
  config: ThumbGenClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ large_hashes: hashes }),
  })
  const body = await response.text()
  return { status: response.status, body }
}

export function fireAndForgetThumbGen(
  hashes: string[],
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch = fetch,
): void {
  const config = resolveThumbGenConfig(env)
  if (!config || hashes.length === 0) return
  const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))]
  void (async () => {
    for (const batch of chunk(unique, MAX_BATCH)) {
      try {
        const result = await postThumbGenBatch(batch, config, fetchImpl)
        console.log(JSON.stringify({
          stage: 'thumb_gen_trigger',
          status: result.status,
          batch_size: batch.length,
          ...(result.status >= 500 ? { body_preview: result.body.slice(0, 200) } : {}),
        }))
      } catch (error) {
        console.log(JSON.stringify({
          stage: 'thumb_gen_trigger',
          status: 'error',
          batch_size: batch.length,
          error: error instanceof Error ? error.message : 'request_failed',
        }))
      }
    }
  })()
}
