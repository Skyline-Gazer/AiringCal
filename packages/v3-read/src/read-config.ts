import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'

/**
 * Single NSFW default for every read surface (Cloudflare, EdgeOne, node gateway).
 *
 * v2 semantics: content is shown unless `NSFW_SHOW` is exactly `false`. Without
 * this helper EdgeOne defaulted to hiding while Cloudflare defaulted to showing,
 * so the same Release rendered differently per platform.
 */
export function resolveNsfwShow(raw: string | null | undefined): boolean {
  return raw?.trim().toLowerCase() !== 'false'
}

/**
 * Fail-closed response for an invalid read configuration (`AIRINGCAL_READ_MODE`,
 * `AIRINGCAL_PUBLIC_BASE_URL`). Configuration is validated when a gateway entry
 * builds its read handler — once per isolate or at process start — so this
 * response carries the exact variable and reason instead of a per-request error
 * from a data route.
 */
export function readConfigErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Invalid read configuration'
  // EdgeOne edge functions do not implement the static `Response.json()`.
  return new Response(JSON.stringify({
    ok: false,
    error: { code: 'INVALID_READ_CONFIG', message },
  }), {
    status: 503,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'Cache-Control': V2_CACHE_CONTROL.error,
    },
  })
}

/**
 * Parse `AIRINGCAL_CORS_ORIGINS` (comma-separated exact origins) for
 * Worker-origin deployments (#72 private-R2: with the bucket private and the
 * Worker as the public origin, there is no bucket CORS or zone rule to carry
 * the allowlist — the Worker itself answers preflight). Wildcards are refused
 * at config time, never silently widened. Empty/unset keeps the previous
 * behavior: OPTIONS is refused with 405 and no CORS headers are emitted.
 */
export function parseCorsAllowedOrigins(raw: string | null | undefined): string[] {
  const origins: string[] = []
  for (const part of String(raw ?? '').split(',')) {
    const value = part.trim()
    if (!value) continue
    if (value.includes('*')) {
      throw new Error(`AIRINGCAL_CORS_ORIGINS must be exact origins (no wildcards): ${value}`)
    }
    if (value !== 'null' && !/^https?:\/\//i.test(value)) {
      throw new Error(`AIRINGCAL_CORS_ORIGINS entries must be absolute http(s) origins or "null": ${value}`)
    }
    const normalized = value === 'null' ? 'null' : value.replace(/\/+$/, '')
    if (!origins.includes(normalized)) origins.push(normalized)
  }
  return origins
}
