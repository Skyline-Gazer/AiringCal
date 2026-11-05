/**
 * EdgeOne Pages Functions entry for the v3 read gateway (#72).
 *
 * Reads the **same** published Release as the Cloudflare gateway over HTTPS from
 * `AIRINGCAL_PUBLIC_BASE_URL` (R2/S3 public bucket behind a CDN). EdgeOne Makers
 * Blob is not a publish authority — the GHA writer never moves the release
 * pointer through Blob — so this entry does not serve from a Blob namespace.
 *
 * STATUS: template only — NOT deployed or staging-verified by CI. Configure
 * `AIRINGCAL_PUBLIC_BASE_URL` as a Pages project Variable (absolute https; a
 * placeholder value fails closed with INVALID_READ_CONFIG) and run the checks in
 * `README.md` / `docs/v3/edgeone-store.md`.
 */
import { handleEdgeOneReadRequest } from '@airing-cal/v3-read/edgeone-read-handler'

/** Isolate-local handler: built (and configuration-validated) on first use. */
let cached = { baseUrl: '', handler: null }

function readHandlerFor(env) {
  const baseUrl = env.AIRINGCAL_PUBLIC_BASE_URL
  if (cached.handler && cached.baseUrl === baseUrl) return cached.handler
  const handler = handleEdgeOneReadRequest({
    publicBaseUrl: baseUrl,
    nsfwShow: env.NSFW_SHOW ? env.NSFW_SHOW !== 'false' : false,
    packageVersion: env.PACKAGE_VERSION,
  })
  cached = { baseUrl, handler }
  return handler
}

function configError(message) {
  return new Response(
    JSON.stringify({ ok: false, error: { code: 'INVALID_READ_CONFIG', message } }),
    { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  )
}

export async function onRequest({ request, env }) {
  if (!env.AIRINGCAL_PUBLIC_BASE_URL) {
    return configError('AIRINGCAL_PUBLIC_BASE_URL is required for the EdgeOne read gateway')
  }
  let handler
  try {
    handler = readHandlerFor(env)
  } catch (error) {
    // Non-https / placeholder base URL: rejected at configuration time, once per isolate.
    return configError(error instanceof Error ? error.message : 'Invalid read configuration')
  }
  return handler(request)
}
