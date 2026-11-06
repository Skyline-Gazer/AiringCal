import { HttpPublicStore } from '@airing-cal/v3-adapters/http-public-store'
import { createPublicBaseUrlValidator } from '@airing-cal/v3-core/public-image-url'
import { handlePortableReadRequest } from './portable-read-handler.ts'
import { createVerifiedSnapshotCache } from './verified-snapshot-cache.ts'

/**
 * EdgeOne read configuration: the Edge runtime fetches the public Release over
 * HTTPS from the public base URL. Blob is **not** a publish authority — the GHA
 * writer publishes into a CAS-capable store (R2/S3) and EdgeOne only reads.
 */
export interface EdgeOneReadConfig {
  /** Raw `AIRINGCAL_PUBLIC_BASE_URL` (C6): absolute https, placeholder rejected. */
  publicBaseUrl: string
  nsfwShow?: boolean
  packageVersion?: string
  /** Pointer object key (default `public/current-release.json`). */
  pointerKey?: string
  /** Custom fetch (tests, or a runtime without the ambient `fetch`). */
  fetch?: typeof fetch
}

export type EdgeOneReadHandler = (request: Request) => Promise<Response>

const validatePublicBaseUrl = createPublicBaseUrlValidator()

/**
 * Builds the EdgeOne Pages/Functions read gateway (#72): the v2-compatible
 * `/api/*` surface served from the same Release as the Cloudflare gateway,
 * fetched through the public CDN/S3 base URL.
 *
 * Configuration is validated once here: a missing, non-https or placeholder
 * base URL throws before any request is served instead of failing per request.
 */
export function createEdgeOneReadHandler(config: EdgeOneReadConfig): EdgeOneReadHandler {
  const publicBaseUrl = validatePublicBaseUrl(config.publicBaseUrl)
  if (!publicBaseUrl) {
    throw new Error('AIRINGCAL_PUBLIC_BASE_URL is required for the EdgeOne read gateway')
  }
  const publicStore = new HttpPublicStore(publicBaseUrl, config.pointerKey, {
    fetch: config.fetch,
  })
  const snapshotCache = createVerifiedSnapshotCache()
  return (request) => handlePortableReadRequest(request, {
    publicStore,
    nsfwShow: config.nsfwShow,
    packageVersion: config.packageVersion,
    publicBaseUrl,
    processEnv: { AIRINGCAL_PLATFORM: 'edgeone' },
    snapshotCache,
  })
}
