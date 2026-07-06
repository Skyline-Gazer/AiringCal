import { generatedCacheJs, generatedWidgetCss, generatedWidgetJs } from './generated-assets.ts'

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

export const cacheJs = generatedCacheJs

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
  return `<footer class="bgm-footer">${buildHtml}<span class="bgm-footer-cache" data-runtime-status>Status loading...</span></footer>`
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
  void env
  return ''
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
  <script src="/src/cache.js"></script>
  ${renderAnalyticsScripts(options.analytics ?? {})}
</body>
</html>`
}
