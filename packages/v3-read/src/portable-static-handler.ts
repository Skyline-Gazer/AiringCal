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
  if (
    path === '/api/sync/apply'
    || path === '/api/sync/compare'
  ) {
    return new Response(DEPRECATED_SYNC, {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': V2_CACHE_CONTROL.error },
    })
  }
  if (path.startsWith('/api/check/')) {
    return new Response(DEPRECATED_SYNC, {
      status: 410,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': V2_CACHE_CONTROL.error },
    })
  }
  return null
}
