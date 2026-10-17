import type { CloudflareR2BucketBinding } from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { handleCloudflareReadRequest } from '@airing-cal/v3-read/cloudflare-read-handler'
import { handlePortableStaticRequest } from '@airing-cal/v3-read/portable-static-handler'

export interface ReadWorkerEnv {
  /** R2 binding holding the immutable v3 public store (see `wrangler.toml`). */
  AIRINGCAL_PUBLIC_R2: CloudflareR2BucketBinding
  /** Git revision rendered on `/` (short sha) and reported by build metadata. */
  BANGUMI_GIT_COMMIT_SHA?: string
  /** Reported by `/api/version`; injected as a Worker var at deploy time. */
  PACKAGE_VERSION?: string
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
  return handleCloudflareReadRequest(request, {
    publicR2: env.AIRINGCAL_PUBLIC_R2,
    packageVersion: env.PACKAGE_VERSION,
  })
}

export default { fetch: handleReadWorkerRequest }
