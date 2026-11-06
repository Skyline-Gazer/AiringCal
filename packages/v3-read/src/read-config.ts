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
