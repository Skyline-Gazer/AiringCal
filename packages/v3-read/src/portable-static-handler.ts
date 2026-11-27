import { renderIndexPage, widgetCss, widgetJs } from '@airing-cal/widget'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'

const DEPRECATED_SYNC = JSON.stringify({
  ok: false,
  error: { code: 'DEPRECATED', message: 'Sync API removed; use operator docs for builder sync.' },
})

/**
 * Deprecated v2 sync surface answers 410 for EVERY method (a POST or
 * preflight must not pretend the route might come back). Exported so the
 * static guard and the read handler answer identically in every runtime.
 */
export function deprecatedSyncResponse(): Response {
  return new Response(DEPRECATED_SYNC, {
    status: 410,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': V2_CACHE_CONTROL.error },
  })
}

/** Matches the NORMALIZED path (after stripping the /api alias prefix). */
export function isDeprecatedSyncPath(path: string): boolean {
  return path === '/sync/apply' || path === '/sync/compare' || path.startsWith('/check/')
}

const STATIC_CACHE = 'public, max-age=300'
const OWNED_PATHS: Record<string, true> = { '/': true, '/src/bangumi.js': true, '/src/bangumi.css': true }

export interface PortableStaticEnv {
  build?: { commitSha?: string }
}

export function handlePortableStaticRequest(request: Request, env: PortableStaticEnv = {}): Response | null {
  const path = new URL(request.url).pathname

  // Deprecated sync endpoints answer 410 for every method before the read-only
  // method guard below: old clients must learn the API is gone, not that GET
  // would work.
  if (path === '/api/sync/apply' || path === '/api/sync/compare' || path.startsWith('/api/check/')) {
    return deprecatedSyncResponse()
  }

  // Owner target contract §6.2: the public surface is read-only (GET/HEAD).
  // The refusal is scoped to the assets THIS handler owns; anything else
  // (including OPTIONS for the read gateway's CORS preflight, which needs
  // its Allow-Methods/204 answer) falls through to the read handler.
  if (Object.hasOwn(OWNED_PATHS, path)) {
    const method = request.method.toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: { 'Allow': 'GET, HEAD', 'Cache-Control': V2_CACHE_CONTROL.error },
      })
    }
  }

  if (path === '/') {
    return new Response(renderIndexPage({ commitSha: env.build?.commitSha }), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': STATIC_CACHE },
    })
  }
  if (path === '/src/bangumi.js') {
    return new Response(widgetJs, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE },
    })
  }
  if (path === '/src/bangumi.css') {
    return new Response(widgetCss, {
      headers: { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': STATIC_CACHE },
    })
  }
  return null
}
