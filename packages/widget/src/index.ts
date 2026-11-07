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

function normalizeRepositoryUrl(repositoryUrl: string): string | undefined {
  try {
    const url = new URL(repositoryUrl.replace(/^git\+/, ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    url.hash = ''
    url.search = ''
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
    return url.href.replace(/\/$/, '')
  } catch {
    return undefined
  }
}

export function renderFooter(build: BuildInfo): string {
  const commit = build.commitSha?.trim()
  const repo = build.repositoryUrl?.trim()
  const normalizedRepo = repo ? normalizeRepositoryUrl(repo) : undefined
  const buildLabel = commit ? `Build ${escapeHtml(commit.slice(0, 7))}` : 'Build unknown'
  const buildHtml = commit && normalizedRepo
    ? `<a href="${escapeHtml(normalizedRepo)}/commit/${escapeHtml(commit)}" target="_blank" rel="noopener noreferrer">${buildLabel}</a>`
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
  <div id="bgm-age-modal" style="display:none;">
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;">
      <div style="background:#16213e;padding:40px;border-radius:12px;text-align:center;max-width:400px;">
        <h2 style="color:#fff;">内容警告</h2>
        <p style="color:#a0a0b0;margin:20px 0;">本页面包含成人内容（R18），您是否已满18岁？</p>
        <button type="button" data-bgm-age="confirm" style="padding:12px 32px;background:#e94560;border:none;border-radius:8px;color:#fff;cursor:pointer;margin:4px;">确认已满18岁</button>
        <button type="button" data-bgm-age="deny" style="padding:12px 32px;background:#0f3460;border:none;border-radius:8px;color:#fff;cursor:pointer;margin:4px;">退出</button>
      </div>
    </div>
  </div>
  ${renderFooter(options.build ?? {})}
  <script src="/src/bangumi.js"></script>
  <script src="/src/cache.js"></script>
  ${renderAnalyticsScripts(options.analytics ?? {})}
</body>
</html>`
}
