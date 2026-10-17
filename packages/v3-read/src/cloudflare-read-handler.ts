import {
  CloudflareR2PublicStore,
  type CloudflareR2BucketBinding,
} from '@airing-cal/v3-adapters/cloudflare-r2-public-store'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { handlePortableReadRequest } from './portable-read-handler.ts'

export interface CloudflareReadEnv {
  publicR2: CloudflareR2BucketBinding
  nsfwShow?: boolean
  packageVersion?: string
  /** R2 object key for mutable release pointer (default `public/current-release.json`). */
  pointerKey?: string
}

/** Workers read gateway entry (#72): v2-compatible `/api/*` over R2-backed PublicStore. */
export async function handleCloudflareReadRequest(
  request: Request,
  env: CloudflareReadEnv,
): Promise<Response> {
  const publicStore = new CloudflareR2PublicStore(
    env.publicR2,
    env.pointerKey ?? PUBLIC_RELEASE_POINTER_KEY,
  )
  return handlePortableReadRequest(request, {
    publicStore,
    nsfwShow: env.nsfwShow,
    packageVersion: env.packageVersion,
    processEnv: { AIRINGCAL_PLATFORM: 'cloudflare' },
  })
}
