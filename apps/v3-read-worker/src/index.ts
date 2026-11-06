import type { CloudflareR2BucketBinding } from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import {
  createCloudflareReadHandler,
  type CloudflareReadHandler,
} from '@airing-cal/v3-read/cloudflare-read-handler'
import { handlePortableStaticRequest } from '@airing-cal/v3-read/portable-static-handler'
import { readConfigErrorResponse } from '@airing-cal/v3-read/read-config'

export interface ReadWorkerEnv {
  /** R2 binding holding the immutable v3 public store (see `wrangler.toml`). */
  AIRINGCAL_PUBLIC_R2: CloudflareR2BucketBinding
  /**
   * Verified public CDN/S3 base URL (C6). Absolute https; a placeholder or
   * non-https value fails closed as `INVALID_READ_CONFIG` when the read
   * configuration is built (first data request per isolate, memoized).
   */
  AIRINGCAL_PUBLIC_BASE_URL?: string
  /** Git revision rendered on `/` (short sha) and reported by build metadata. */
  BANGUMI_GIT_COMMIT_SHA?: string
  /** Reported by `/api/version`; injected as a Worker var at deploy time. */
  PACKAGE_VERSION?: string
}

/** Isolate-lifetime handler: rebuilt only when binding/config fingerprint changes. */
let cachedReadHandler: {
  fingerprint: string
  binding: CloudflareR2BucketBinding
  handler: CloudflareReadHandler
} | null = null

function readHandlerFingerprint(env: ReadWorkerEnv): string {
  return [
    env.AIRINGCAL_PUBLIC_BASE_URL ?? '',
    env.PACKAGE_VERSION ?? '',
  ].join('|')
}

function readHandlerFor(env: ReadWorkerEnv): CloudflareReadHandler {
  const binding = env.AIRINGCAL_PUBLIC_R2
  const fingerprint = readHandlerFingerprint(env)
  if (
    cachedReadHandler
    && cachedReadHandler.binding === binding
    && cachedReadHandler.fingerprint === fingerprint
  ) {
    return cachedReadHandler.handler
  }
  const handler = createCloudflareReadHandler({
    publicR2: binding,
    publicBaseUrl: env.AIRINGCAL_PUBLIC_BASE_URL,
    packageVersion: env.PACKAGE_VERSION,
  })
  cachedReadHandler = { fingerprint, binding, handler }
  return handler
}

/** Cloudflare Workers entry for the v3 read gateway (#72): widget assets, v2 `/api/*`, `/image/:hash`. */
export async function handleReadWorkerRequest(
  request: Request,
  env: ReadWorkerEnv,
): Promise<Response> {
  const staticResponse = handlePortableStaticRequest(request, {
    build: env.BANGUMI_GIT_COMMIT_SHA ? { commitSha: env.BANGUMI_GIT_COMMIT_SHA } : undefined,
  })
  if (staticResponse) return staticResponse
  if (!env.AIRINGCAL_PUBLIC_R2) {
    return Response.json({
      ok: false,
      error: {
        code: 'NO_PUBLIC_STORE_BINDING',
        message: 'AIRINGCAL_PUBLIC_R2 binding is not configured for this Worker',
      },
    }, { status: 503, headers: { 'Cache-Control': V2_CACHE_CONTROL.error } })
  }
  let handleRead: CloudflareReadHandler
  try {
    handleRead = readHandlerFor(env)
  } catch (error) {
    return readConfigErrorResponse(error)
  }
  return handleRead(request)
}

export default { fetch: handleReadWorkerRequest }
