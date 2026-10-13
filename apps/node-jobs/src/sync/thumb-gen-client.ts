const MAX_BATCH = 50

export interface ThumbGenClientConfig {
  url: string
  bearer: string
}

export function resolveThumbGenConfig(env: Record<string, string | undefined>): ThumbGenClientConfig | null {
  const url = env.AIRINGCAL_THUMB_GEN_URL?.trim()
    || (env.AIRINGCAL_WEB_ORIGIN?.trim() ? `${env.AIRINGCAL_WEB_ORIGIN.trim().replace(/\/$/, '')}/api/thumb-gen` : '')
  const bearer = env.AIRINGCAL_THUMB_GEN_BEARER?.trim() ?? ''
  if (!url) return null
  if (!bearer) return null
  return { url, bearer }
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
