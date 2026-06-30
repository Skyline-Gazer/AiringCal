export const appBoundary = 'frontend-worker'

import { renderCachePage, renderIndexPage, widgetCss, widgetJs, type BuildInfo } from '@airing-cal/widget'

interface FrontendEnv {
  READ_WORKER: { fetch(request: Request): Promise<Response> }
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

function buildInfo(env: FrontendEnv): BuildInfo {
  return {
    commitSha: env.BANGUMI_GIT_COMMIT_SHA,
    repositoryUrl: env.BANGUMI_GIT_REPOSITORY_URL,
  }
}

function pageOptions(env: FrontendEnv) {
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

function readWorkerRequest(url: URL, path: string, request: Request): Request {
  const target = new URL(url)
  target.pathname = path
  return new Request(target, request)
}

async function fetch(request: Request, env: FrontendEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/') return text(renderIndexPage(pageOptions(env)), 'text/html; charset=utf-8')
  if (url.pathname === '/cache') return text(renderCachePage(pageOptions(env)), 'text/html; charset=utf-8')
  if (url.pathname === '/src/bangumi.js') return text(widgetJs, 'application/javascript; charset=utf-8')
  if (url.pathname === '/src/bangumi.css') return text(widgetCss, 'text/css; charset=utf-8')

  if (url.pathname === '/api/collections') return env.READ_WORKER.fetch(readWorkerRequest(url, '/collections', request))
  if (url.pathname === '/api/calendar') return env.READ_WORKER.fetch(readWorkerRequest(url, '/calendar', request))
  if (url.pathname === '/api/config') return env.READ_WORKER.fetch(readWorkerRequest(url, '/config', request))
  if (url.pathname === '/api/health') return env.READ_WORKER.fetch(readWorkerRequest(url, '/health', request))
  if (url.pathname === '/api/cache') return env.READ_WORKER.fetch(readWorkerRequest(url, '/cache', request))
  if (url.pathname.startsWith('/image/')) return env.READ_WORKER.fetch(readWorkerRequest(url, url.pathname, request))

  return new Response('Not found', { status: 404 })
}

export default { fetch }
