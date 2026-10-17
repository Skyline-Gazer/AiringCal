/**
 * EdgeOne Pages Functions entry for the v3 read gateway (#72).
 *
 * STATUS: template only — NOT deployed or staging-verified. An EdgeOne Makers
 * Blob account requires operator approval; once a Blob namespace is bound,
 * adjust `PUBLIC_BLOB` below to the bound variable name, deploy, and run the
 * checks in `README.md` / `docs/v3/edgeone-store.md` before trusting it.
 *
 * This catch-all adapts the bound Makers Blob store to `EdgeOneBlobBinding`
 * (`get`/`getWithHeaders`/`set`/`list` from `@edgeone/pages-blob`), then delegates
 * to `handleEdgeOneReadRequest` which shares the filesystem/R2 key layout.
 */
import { getStore } from '@edgeone/pages-blob'
import { handleEdgeOneReadRequest } from '@airing-cal/v3-read/edgeone-read-handler'

/** Namespace bound in the EdgeOne console; match the binding "Variable Name". */
const PUBLIC_BLOB = 'AIRINGCAL_PUBLIC_BLOB'

export async function onRequest({ request, env }) {
  // env[PUBLIC_BLOB] is the bound Blob namespace when using a binding variable;
  // with @edgeone/pages-blob you may instead resolve the store directly:
  //   const store = getStore({ name: 'airing-cal-public', projectId, token })
  const blob = env[PUBLIC_BLOB]
  if (!blob) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: 'NO_PUBLIC_BLOB_BINDING', message: `${PUBLIC_BLOB} binding is not configured` },
      }),
      { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
    )
  }
  return handleEdgeOneReadRequest(request, {
    publicBlob: blob,
    nsfwShow: env.NSFW_SHOW ? env.NSFW_SHOW !== 'false' : false,
    packageVersion: env.PACKAGE_VERSION,
  })
}
