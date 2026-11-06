/**
 * EdgeOne Pages Functions entry for the v3 read gateway (#72).
 *
 * Reads the **same** published Release as the Cloudflare gateway over HTTPS from
 * `AIRINGCAL_PUBLIC_BASE_URL` (R2/S3 public bucket behind a CDN). EdgeOne Makers
 * Blob is not a publish authority — the GHA writer never moves the release
 * pointer through Blob — so this entry does not serve from a Blob namespace.
 *
 * STATUS: deployed and staging-verified on the EdgeOne Makers project
 * `airingcal-edgeone-read` (2026-11-06). The file must keep the documented
 * catch-all name `[[default]].js` under `edge-functions/`; a `[[path]].js` route
 * is not registered and every request 404s. Configure `AIRINGCAL_PUBLIC_BASE_URL`
 * as a project variable (absolute https; a placeholder fails closed with
 * INVALID_READ_CONFIG).
 */
import { createEdgeOneReadHandler } from '@airing-cal/v3-read/edgeone-read-handler'
import { resolveNsfwShow } from '@airing-cal/v3-read/read-config'

/** Isolate-local handler: rebuilt only when config fingerprint changes. */
let cached = { fingerprint: '', handler: null }

function handlerFingerprint(env) {
  return [
    env.AIRINGCAL_PUBLIC_BASE_URL ?? '',
    String(resolveNsfwShow(env.NSFW_SHOW)),
    env.PACKAGE_VERSION ?? '',
  ].join('|')
}

function readHandlerFor(env) {
  const fingerprint = handlerFingerprint(env)
  if (cached.handler && cached.fingerprint === fingerprint) return cached.handler
  const handler = createEdgeOneReadHandler({
    publicBaseUrl: env.AIRINGCAL_PUBLIC_BASE_URL,
    nsfwShow: resolveNsfwShow(env.NSFW_SHOW),
    packageVersion: env.PACKAGE_VERSION,
  })
  cached = { fingerprint, handler }
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
