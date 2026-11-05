export const readModeBoundary = 'web-worker-read-mode'

import type { CloudflareR2BucketBinding } from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { createPublicBaseUrlValidator } from '@airing-cal/v3-core/public-image-url'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import { createCloudflareReadHandler } from '@airing-cal/v3-read/cloudflare-read-handler'

/** Env var that opts the public Worker into reading the v3 Release (C7). */
export const READ_MODE_ENV = 'AIRINGCAL_READ_MODE'

export type WebReadMode = 'legacy' | 'v3-release'

const READ_MODES: readonly WebReadMode[] = ['legacy', 'v3-release']

/** Routes the portable v3 gateway owns when the mode is `v3-release` (same surface as legacy). */
const V3_RELEASE_ROUTES = [
  '/api/collections',
  '/api/calendar',
  '/api/config',
  '/api/health',
  '/api/cache',
] as const

export interface WebReadModeEnv {
  /** Unset / `legacy` keeps the phase-0 read path unchanged; `v3-release` reads the public Release. */
  AIRINGCAL_READ_MODE?: string
  /** Verified public CDN/S3 base URL (C6): absolute https, placeholder rejected. */
  AIRINGCAL_PUBLIC_BASE_URL?: string
  /** R2 binding holding the v3 public Release (`airing-cal-public` layout). */
  AIRINGCAL_PUBLIC_R2?: CloudflareR2BucketBinding
  NSFW_SHOW?: 'true' | 'false'
  PACKAGE_VERSION?: string
}

export type WebReadModeConfig =
  | { mode: 'legacy' }
  | { mode: 'v3-release'; publicBaseUrl?: string }

export class InvalidReadModeError extends Error {
  readonly code = 'INVALID_READ_MODE'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidReadModeError'
  }
}

export function parseReadMode(value?: string | null): WebReadMode {
  const trimmed = value?.trim()
  if (!trimmed) return 'legacy'
  if (READ_MODES.includes(trimmed as WebReadMode)) return trimmed as WebReadMode
  throw new InvalidReadModeError(
    `${READ_MODE_ENV} must be one of ${READ_MODES.join('|')} (got "${value}")`,
  )
}

/** True for the JSON/image routes the v3 Release gateway serves. */
export function isV3ReleaseReadPath(pathname: string): boolean {
  return pathname.startsWith('/image/')
    || V3_RELEASE_ROUTES.some((route) => route === pathname)
}

const validatePublicBaseUrl = createPublicBaseUrlValidator()

/**
 * Resolves the read-mode configuration (C6/C7).
 *
 * Every route resolves this before serving, so an unknown mode or a placeholder
 * `AIRINGCAL_PUBLIC_BASE_URL` fails at configuration time (first request per
 * isolate, memoized) instead of surfacing as a per-request image error.
 */
export function resolveReadModeConfig(env: WebReadModeEnv): WebReadModeConfig {
  const mode = parseReadMode(env.AIRINGCAL_READ_MODE)
  if (mode === 'legacy') return { mode }
  return {
    mode,
    publicBaseUrl: validatePublicBaseUrl(env.AIRINGCAL_PUBLIC_BASE_URL) ?? undefined,
  }
}

/**
 * Serves a catalog/image/health route from the shared public Release via
 * `handlePortableReadRequest` (Cloudflare R2-backed gateway).
 *
 * Fail-closed: without the `AIRINGCAL_PUBLIC_R2` binding the Worker returns 503
 * `NO_PUBLIC_STORE_BINDING` rather than silently falling back to legacy reads.
 */
export async function handleV3ReleaseReadRequest(
  request: Request,
  env: WebReadModeEnv,
): Promise<Response> {
  const config = resolveReadModeConfig(env)
  if (!env.AIRINGCAL_PUBLIC_R2) {
    return Response.json({
      ok: false,
      error: {
        code: 'NO_PUBLIC_STORE_BINDING',
        message: `${READ_MODE_ENV}=v3-release requires the AIRINGCAL_PUBLIC_R2 binding`,
      },
    }, { status: 503, headers: { 'Cache-Control': V2_CACHE_CONTROL.error } })
  }
  return createCloudflareReadHandler({
    publicR2: env.AIRINGCAL_PUBLIC_R2,
    publicBaseUrl: config.mode === 'v3-release' ? config.publicBaseUrl : undefined,
    nsfwShow: env.NSFW_SHOW !== 'false',
    packageVersion: env.PACKAGE_VERSION,
  })(request)
}
