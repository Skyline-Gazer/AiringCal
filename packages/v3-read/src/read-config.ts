import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'

/**
 * Fail-closed response for an invalid read configuration (`AIRINGCAL_READ_MODE`,
 * `AIRINGCAL_PUBLIC_BASE_URL`). Configuration is validated when a gateway entry
 * builds its read handler — once per isolate or at process start — so this
 * response carries the exact variable and reason instead of a per-request error
 * from a data route.
 */
export function readConfigErrorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'Invalid read configuration'
  return Response.json({
    ok: false,
    error: { code: 'INVALID_READ_CONFIG', message },
  }, {
    status: 503,
    headers: { 'Cache-Control': V2_CACHE_CONTROL.error },
  })
}
