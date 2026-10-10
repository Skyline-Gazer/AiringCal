export const appBoundary = 'web-worker'

import { cacheJs, renderIndexPage, widgetCss, widgetJs, type BuildInfo } from '@airing-cal/widget'
import { handleReadRequest, type WebWorkerEnv } from './read-api.ts'

interface WebEnv extends WebWorkerEnv {
  BANGUMI_GIT_COMMIT_SHA?: string
  BANGUMI_GIT_REPOSITORY_URL?: string
  BANGUMI_GOOGLE_SITE_VERIFICATION?: string
  BANGUMI_YANDEX_VERIFICATION?: string
  BANGUMI_BING_SITE_VERIFICATION?: string
  BANGUMI_BAIDU_SITE_VERIFICATION?: string
  BANGUMI_GA4_ID?: string
  BANGUMI_CLARITY_ID?: string
  BANGUMI_YANDEX_METRICA_ID?: string
  BANGUMI_BAIDU_TONGJI_ID?: string
}

function buildInfo(env: WebEnv): BuildInfo {
  return {
    commitSha: env.BANGUMI_GIT_COMMIT_SHA,
    repositoryUrl: env.BANGUMI_GIT_REPOSITORY_URL,
  }
}

function pageOptions(env: WebEnv) {
  return {
    build: buildInfo(env),
    verification: {
      googleSiteVerification: env.BANGUMI_GOOGLE_SITE_VERIFICATION,
      yandexVerification: env.BANGUMI_YANDEX_VERIFICATION,
      bingSiteVerification: env.BANGUMI_BING_SITE_VERIFICATION,
      baiduSiteVerification: env.BANGUMI_BAIDU_SITE_VERIFICATION,
    },
    analytics: {
      ga4Id: env.BANGUMI_GA4_ID,
      clarityId: env.BANGUMI_CLARITY_ID,
      yandexMetricaId: env.BANGUMI_YANDEX_METRICA_ID,
      baiduTongjiId: env.BANGUMI_BAIDU_TONGJI_ID,
    },
  }
}

function text(body: string, contentType: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
    },
  })
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  })
}

function apiRequest(url: URL, readSuffix: string, request: Request): Request {
  const target = new URL(url)
  target.pathname = readSuffix
  return new Request(target, request)
}

const DEPRECATED_SYNC = JSON.stringify({
  ok: false,
  error: { code: 'DEPRECATED', message: 'In-page account sync was removed; scheduled sync moves to QingLong.' },
})

function deprecatedSync(): Response {
  return new Response(DEPRECATED_SYNC, {
    status: 410,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

async function fetch(request: Request, env: WebEnv): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === '/') return html(renderIndexPage(pageOptions(env)))
  if (url.pathname === '/src/bangumi.js') return text(widgetJs, 'application/javascript; charset=utf-8')
  if (url.pathname === '/src/bangumi.css') return text(widgetCss, 'text/css; charset=utf-8')
  if (url.pathname === '/src/cache.js') return text(cacheJs, 'application/javascript; charset=utf-8')

  if (url.pathname === '/api/sync/compare' || url.pathname === '/api/sync/apply') return deprecatedSync()
  if (url.pathname.startsWith('/api/check/')) return deprecatedSync()

  if (url.pathname === '/api/collections') {
    return (await handleReadRequest(apiRequest(url, '/collections', request), env)) ?? new Response('Not found', { status: 404 })
  }
  if (url.pathname === '/api/calendar') {
    return (await handleReadRequest(apiRequest(url, '/calendar', request), env)) ?? new Response('Not found', { status: 404 })
  }
  if (url.pathname === '/api/config') {
    return (await handleReadRequest(apiRequest(url, '/config', request), env)) ?? new Response('Not found', { status: 404 })
  }
  if (url.pathname === '/api/health') {
    return (await handleReadRequest(apiRequest(url, '/health', request), env)) ?? new Response('Not found', { status: 404 })
  }
  if (url.pathname === '/api/cache') {
    return (await handleReadRequest(apiRequest(url, '/cache', request), env)) ?? new Response('Not found', { status: 404 })
  }
  if (url.pathname.startsWith('/image/')) {
    return (await handleReadRequest(apiRequest(url, url.pathname, request), env)) ?? new Response('Not found', { status: 404 })
  }

  return new Response('Not found', { status: 404 })
}

export default { fetch }
