import {
  CloudflareR2PublicStore,
  type CloudflareR2BucketBinding,
} from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { createPublicBaseUrlValidator } from '@airing-cal/v3-core/public-image-url'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { parseCorsAllowedOrigins } from './read-config.ts'
import { createVerifiedSnapshotCache } from './verified-snapshot-cache.ts'

/** Write-once configuration: everything the R2-backed gateway needs to serve a Release. */
export interface CloudflareReadConfig {
  publicR2: CloudflareR2BucketBinding
  nsfwShow?: boolean
  packageVersion?: string
  /** Built commit (`BANGUMI_GIT_COMMIT_SHA`), reported by `/api/version`. */
  build?: { commitSha?: string }
  /** R2 object key for mutable release pointer (default `public/current-release.json`). */
  pointerKey?: string
  /**
   * Raw `AIRINGCAL_PUBLIC_BASE_URL` (C6): absolute https, placeholder rejected.
   * Validated when the handler is built — a bad value throws at config time, never
   * per request.
   */
  publicBaseUrl?: string
  /**
   * Optional raw `AIRINGCAL_IMAGE_BASE_URL`. When set, `/image/*` redirects use this
   * host; when unset, redirects reuse `publicBaseUrl` (Image CDN off by default).
   */
  imageBaseUrl?: string
  /**
   * Raw `AIRINGCAL_CORS_ORIGINS` (comma-separated exact origins). Parsed once
   * at handler build; wildcards and malformed entries throw (fail closed).
   * Unset = no CORS surface in the Worker (edge-configured deployments).
   */
  corsAllowedOrigins?: string
}

export type CloudflareReadHandler = (request: Request) => Promise<Response>

const validatePublicBaseUrl = createPublicBaseUrlValidator()

/** Builds the Workers read gateway handler (#72, C6): v2-compatible `/api/*` over an R2 PublicStore. */
export function createCloudflareReadHandler(config: CloudflareReadConfig): CloudflareReadHandler {
  const publicBaseUrl = validatePublicBaseUrl(config.publicBaseUrl) ?? undefined
  const imageBaseUrl = validatePublicBaseUrl(config.imageBaseUrl) ?? undefined
  const corsAllowedOrigins = parseCorsAllowedOrigins(config.corsAllowedOrigins)
  const publicStore = new CloudflareR2PublicStore(
    config.publicR2,
    config.pointerKey ?? PUBLIC_RELEASE_POINTER_KEY,
  )
  const snapshotCache = createVerifiedSnapshotCache()
  return (request) => handlePortableReadRequest(request, {
    publicStore,
    nsfwShow: config.nsfwShow,
    packageVersion: config.packageVersion,
    build: config.build,
    publicBaseUrl,
    imageBaseUrl,
    corsAllowedOrigins,
    processEnv: { AIRINGCAL_PLATFORM: 'cloudflare' },
    snapshotCache,
  })
}
