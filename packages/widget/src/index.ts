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

export const widgetCss = `:root{color-scheme:light dark}.bgm-footer{margin:24px 0 0;font:12px/1.5 system-ui,sans-serif;color:#666}.bgm-footer a{color:inherit}.bgm-cache-table{width:100%;border-collapse:collapse}.bgm-cache-table th,.bgm-cache-table td{border:1px solid #ddd;padding:6px;text-align:left}`

export const widgetJs = `(function(){function subjectImageUrl(images){return images?.common?.uri?window.location.origin+images.common.uri:null}window.__bangumiWidget={subjectImageUrl}})();`

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
  ${renderAnalyticsScripts(options.analytics ?? {})}
</body>
</html>`
}
