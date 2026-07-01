import { generatedWidgetCss, generatedWidgetJs } from './generated-assets.ts'

export const packageBoundary = '@airing-cal/widget'

export interface BuildInfo {
  commitSha?: string
  repositoryUrl?: string
}

export interface VerificationEnv {
  googleSiteVerification?: string
  yandexVerification?: string
  bingSiteVerification?: string
  baiduSiteVerification?: string
}

export interface AnalyticsEnv {
  ga4Id?: string
  clarityId?: string
  yandexMetricaId?: string
  baiduTongjiId?: string
}

export const widgetCss = generatedWidgetCss

export const widgetJs = generatedWidgetJs

export const cacheJs = `
(() => {
  const root = document.getElementById('bgm-cache-root')
  if (!root) return

  function row(label, counts) {
    const total = Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0)
    return '<tr><th>' + label + '</th><td>' + total + '</td><td>' +
      ['cached', 'pending_next_cron', 'queued', 'failed', 'missing_source'].map((key) => key + ': ' + Number((counts || {})[key] || 0)).join('<br>') +
      '</td></tr>'
  }

  fetch('/api/cache')
    .then((response) => response.json())
    .then((data) => {
      root.innerHTML = '<p>Total subjects: ' + Number(data.total_subjects || 0) + '</p>' +
        '<table class="bgm-cache-table"><tbody>' + row('common', data.common) + row('large', data.large) + '</tbody></table>'
    })
    .catch((error) => {
      root.textContent = 'Cache statistics unavailable: ' + (error && error.message ? error.message : String(error))
    })
})()
`

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function normalizeRepositoryUrl(repositoryUrl: string): string {
  return repositoryUrl
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
}

export function renderFooter(build: BuildInfo): string {
  const commit = build.commitSha?.trim()
  const repo = build.repositoryUrl?.trim()
  const buildLabel = commit ? `Build ${escapeHtml(commit.slice(0, 7))}` : 'Build unknown'
  const buildHtml = commit && repo
    ? `<a href="${escapeHtml(normalizeRepositoryUrl(repo))}/commit/${escapeHtml(commit)}">${buildLabel}</a>`
    : `<span>${buildLabel}</span>`
  return `<footer class="bgm-footer"><a href="/cache">Cache statistics</a><span> · </span>${buildHtml}</footer>`
}

export function renderWebmasterMeta(env: VerificationEnv): string {
  const tags = [
    env.googleSiteVerification ? `<meta name="google-site-verification" content="${escapeHtml(env.googleSiteVerification)}">` : '',
    env.yandexVerification ? `<meta name="yandex-verification" content="${escapeHtml(env.yandexVerification)}">` : '',
    env.bingSiteVerification ? `<meta name="msvalidate.01" content="${escapeHtml(env.bingSiteVerification)}">` : '',
    env.baiduSiteVerification ? `<meta name="baidu-site-verification" content="${escapeHtml(env.baiduSiteVerification)}">` : '',
  ]
  return tags.filter(Boolean).join('\n')
}

export function renderAnalyticsScripts(env: AnalyticsEnv): string {
  const snippets = [
    env.ga4Id ? `<!-- GA4 ${escapeHtml(env.ga4Id)} -->` : '',
    env.clarityId ? `<!-- Clarity ${escapeHtml(env.clarityId)} -->` : '',
    env.yandexMetricaId ? `<!-- Yandex Metrica ${escapeHtml(env.yandexMetricaId)} -->` : '',
    env.baiduTongjiId ? `<!-- Baidu Tongji ${escapeHtml(env.baiduTongjiId)} -->` : '',
  ]
  return snippets.filter(Boolean).join('\n')
}

export function renderIndexPage(options: { build?: BuildInfo; verification?: VerificationEnv; analytics?: AnalyticsEnv } = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderWebmasterMeta(options.verification ?? {})}
  <link rel="stylesheet" href="/src/bangumi.css">
  <title>AiringCal</title>
</head>
<body>
  <div class="bgm-container"></div>
  ${renderFooter(options.build ?? {})}
  <script src="/src/bangumi.js"></script>
  ${renderAnalyticsScripts(options.analytics ?? {})}
</body>
</html>`
}

export function renderCachePage(options: { build?: BuildInfo; verification?: VerificationEnv; analytics?: AnalyticsEnv } = {}): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${renderWebmasterMeta(options.verification ?? {})}
  <link rel="stylesheet" href="/src/bangumi.css">
  <title>AiringCal Cache</title>
</head>
<body>
  <main class="bgm-cache-page">
    <h1>Cache statistics</h1>
    <div id="bgm-cache-root"></div>
  </main>
  ${renderFooter(options.build ?? {})}
  <script src="/src/cache.js"></script>
  ${renderAnalyticsScripts(options.analytics ?? {})}
</body>
</html>`
}
