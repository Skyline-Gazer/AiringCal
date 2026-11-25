import {
  cacheJs,
  renderIndexPage,
  widgetCss,
  widgetJs,
  type BuildInfo,
} from '@airing-cal/widget'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'

const DEPRECATED_SYNC = JSON.stringify({
  ok: false,
  error: { code: 'DEPRECATED', message: 'Sync API removed; use operator docs for builder sync.' },
})

const STATIC_CACHE = 'public, max-age=300'

export interface PortableStaticEnv {
  build?: BuildInfo
}

export function handlePortableStaticRequest(
  request: Request,
  env: PortableStaticEnv = {},
): Response | null {
  const url = new URL(request.url)
  const path = url.pathname

  // Deprecated sync endpoints answer 410 for every method before the read-only
  // method guard below: old clients must learn the API is gone, not that GET
  // would work.
  if (
    path === '/api/sync/apply'
    || path === '/api/sync/compare'
    || path.startsWith('/api/check/')
  ) {
    return new Response(DEPRECATED_SYNC, {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': V2_CACHE_CONTROL.error },
    })
  }

  // Owner target contract §6.2: the public surface is read-only (GET/HEAD).
  // The refusal is scoped to the assets THIS handler owns; anything else
  // (including OPTIONS for the read gateway's CORS preflight, which needs
  // its Allow-Methods/204 answer) falls through to the read handler, which
  // owns the method policy for its own routes.
  const method = request.method.toUpperCase()
  const owned = path === '/' || path === '/src/bangumi.js' || path === '/src/bangumi.css' || path === '/src/cache.js'
  if (owned && method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Allow': 'GET, HEAD', 'Cache-Control': V2_CACHE_CONTROL.error },
    })
  }

  if (path === '/') {
    return new Response(renderIndexPage({ build: env.build }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': STATIC_CACHE,
      },
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
  if (path === '/src/cache.js') {
    return new Response(cacheJs, {
      headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': STATIC_CACHE },
    })
  }
  return null
}
