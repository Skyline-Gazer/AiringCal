import {
  EdgeOnePublicStore,
  type EdgeOneBlobBinding,
} from '@airing-cal/v3-adapters/edgeone-public-store'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { handlePortableReadRequest } from './portable-read-handler.ts'

export interface EdgeOneReadEnv {
  publicBlob: EdgeOneBlobBinding
  nsfwShow?: boolean
  packageVersion?: string
  /** Blob object key for the mutable release pointer (default `public/current-release.json`). */
  pointerKey?: string
}

/**
 * EdgeOne Makers Functions read gateway (#72): v2-compatible `/api/*` over the
 * Blob-backed `PublicStore`, sharing the filesystem/R2 key layout so the same
 * published release serves every platform.
 *
 * Edge Functions call this with the bound Blob namespace (`env.<variable name>`).
 * Publishing stays outside this handler: Blob has no conditional write, so the
 * release pointer is moved by a CAS-capable store or a single-writer path.
 */
export async function handleEdgeOneReadRequest(
  request: Request,
  env: EdgeOneReadEnv,
): Promise<Response> {
  const publicStore = new EdgeOnePublicStore(
    env.publicBlob,
    env.pointerKey ?? PUBLIC_RELEASE_POINTER_KEY,
  )
  return handlePortableReadRequest(request, {
    publicStore,
    nsfwShow: env.nsfwShow,
    packageVersion: env.packageVersion,
    processEnv: { AIRINGCAL_PLATFORM: 'edgeone' },
  })
}
