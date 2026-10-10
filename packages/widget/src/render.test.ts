import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cacheJs,
  renderFooter,
  renderIndexPage,
  renderAnalyticsScripts,
  renderWebmasterMeta,
  widgetJs,
  widgetCss,
} from './index.ts'

const widgetRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `${name} should exist in the packaged asset`)
  const bodyStart = source.indexOf('{', start)
  let depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1)
  }
  throw new Error(`could not extract ${name}`)
}

function loadWidgetSecurityHelpers() {
  return Function(
    'location',
    `${extractFunction(widgetJs, 'escapeHtml')}\n${extractFunction(widgetJs, 'escapeAttribute')}\n${extractFunction(widgetJs, 'safeUrl')}\nreturn { escapeHtml, escapeAttribute, safeUrl }`,
  )({ origin: 'https://widget.example' }) as {
    escapeHtml(value: unknown): string
    escapeAttribute(value: unknown): string
    safeUrl(value: unknown, fallback?: string): string
  }
}

function loadWidgetProductionRenderers() {
  const source = [
    'escapeHtml',
    'escapeAttribute',
    'safeUrl',
    'safeNumber',
    'safeScore',
    'subjectImageUrl',
    'imageCacheLabel',
    'renderCover',
    'renderSubjectCard',
    'renderCalendarCard',
  ].map((name) => extractFunction(widgetJs, name)).join('\n')

  return Function(
    'location',
    `var API = location.origin
    ${source}
    return {
      renderSubjectCard,
      renderCalendar(days) {
        var cal = { innerHTML: '' }
        var todayId = 1
        ${extractFunction(widgetJs, 'renderCalendar')}
        renderCalendar(days)
        return cal.innerHTML
      },
    }`,
  )({ origin: 'https://widget.example' }) as {
    renderSubjectCard(card: Record<string, unknown>): string
    renderCalendar(days: unknown[]): string
  }
}

test('renderFooter omits cache page link and links commit when SHA and repository are present', () => {
  const footer = renderFooter({
    commitSha: '0123456789abcdef',
    repositoryUrl: 'https://github.com/markd3ng/AiringCal',
  })

  assert.equal(footer.includes('href="/cache"'), false)
  assert.match(footer, /Build 0123456/)
  assert.match(footer, /https:\/\/github.com\/markd3ng\/AiringCal\/commit\/0123456789abcdef/)
  assert.match(footer, /target="_blank" rel="noopener noreferrer"/)
  assert.match(footer, /data-runtime-status/)
})

test('renderFooter falls back to Build unknown without commit link', () => {
  const footer = renderFooter({})

  assert.match(footer, /Build unknown/)
  assert.equal(footer.includes('/commit/'), false)
})

test('renderFooter rejects non-HTTP repository protocols', () => {
  for (const repositoryUrl of [
    'javascript:alert(document.domain)',
    'data:text/html,<script>alert(document.domain)</script>',
  ]) {
    const footer = renderFooter({ commitSha: '0123456789abcdef', repositoryUrl })

    assert.match(footer, /<span>Build 0123456<\/span>/)
    assert.equal(footer.includes('<a '), false)
    assert.equal(footer.includes('href='), false)
  }
})

test('renderFooter links normalized HTTP and HTTPS repository URLs', () => {
  const cases = [
    ['http://example.test/owner/repo/', 'http://example.test/owner/repo/commit/0123456789abcdef'],
    ['git+https://example.test/owner/repo.git/', 'https://example.test/owner/repo/commit/0123456789abcdef'],
  ] as const

  for (const [repositoryUrl, expectedCommitUrl] of cases) {
    const footer = renderFooter({ commitSha: '0123456789abcdef', repositoryUrl })

    assert.match(footer, new RegExp(`href="${expectedCommitUrl}"`))
    assert.match(footer, /target="_blank" rel="noopener noreferrer"/)
  }
})

test('public pages reuse the exact shared footer output', () => {
  const build = { commitSha: 'abcdef0123456789', repositoryUrl: 'https://github.com/markd3ng/AiringCal' }
  const footer = renderFooter(build)

  assert.equal(renderIndexPage({ build }).includes(footer), true)
})

test('renderFooter exposes an inline runtime status slot without cache loading copy', () => {
  const footer = renderFooter({})

  assert.equal(footer.includes('href="/cache"'), false)
  assert.match(footer, /data-runtime-status/)
  assert.match(footer, /Status loading/)
  assert.equal(footer.includes('Cache loading'), false)
})

test('renderWebmasterMeta emits only configured verification tags', () => {
  const html = renderWebmasterMeta({
    googleSiteVerification: 'google-token',
    bingSiteVerification: 'bing-token',
  })

  assert.match(html, /name="google-site-verification" content="google-token"/)
  assert.match(html, /name="msvalidate\.01" content="bing-token"/)
  assert.equal(html.includes('yandex-verification'), false)
  assert.equal(html.includes('baidu-site-verification'), false)
})

test('renderAnalyticsScripts does not emit placeholder analytics snippets', () => {
  const html = renderAnalyticsScripts({
    ga4Id: 'G-TEST',
    clarityId: 'clarity',
    yandexMetricaId: 'yandex',
    baiduTongjiId: 'baidu',
  })

  assert.equal(html, '')
})

test('widgetJs consumes new images.common.uri shape', () => {
  assert.match(widgetJs, /images\?\.common\?\.uri/)
  assert.match(widgetJs, /document\.querySelector\('\.bgm-container'\)/)
  assert.equal(widgetJs.includes('hash_large'), false)
})

test('widgetJs uses eps as the collection total episode fallback', () => {
  assert.match(widgetJs, /entry\.eps \|\| entry\.total_episodes/)
})

test('widgetJs uses total_episodes before eps for calendar episode totals', () => {
  assert.match(widgetJs, /entry\.total_episodes \|\| entry\.eps/)
})

test('widgetJs accepts legacy and sync episode count field names for calendar cards', () => {
  assert.match(widgetJs, /entry\.eps_count/)
  assert.match(widgetJs, /entry\.totalEpisodes/)
})

test('widgetJs does not render unknown calendar episode totals as question marks', () => {
  assert.match(widgetJs, /function formatCalendarEpisodeMeta\(entry\)/)
  assert.match(widgetJs, /return episodeTotal > 0 \? episodeTotal \+ ' 话' : '集数待定'/)
  assert.equal(widgetJs.includes("|| '??') + ' 话'"), false)
  assert.equal(widgetJs.includes("'??') + ' 话'"), false)
})

test('widgetJs renders precise cache status text when image cache is unavailable', () => {
  assert.match(widgetJs, /entry\.image_status/)
  assert.match(widgetJs, /imageStatus\?\.common/)
  assert.match(widgetJs, /image pending/)
  assert.match(widgetJs, /image missing source/)
  assert.match(widgetJs, /image cache failed/)
  assert.equal(widgetJs.includes('data:image'), false)
})

test('widgetJs no longer ships in-page account sync UI', () => {
  assert.doesNotMatch(widgetJs, /动画同步/)
  assert.doesNotMatch(widgetJs, /\/api\/sync\/compare/)
  assert.doesNotMatch(widgetJs, /\/api\/sync\/apply/)
})

test('production widget renderers encode every hostile API sink', () => {
  const renderers = loadWidgetProductionRenderers()
  const payloads = ['<img src=x onerror=alert(1)>', '" onmouseover=alert(1) x="', '</pre><script>alert(1)</script>']

  for (const payload of payloads) {
    const outputs = [
      renderers.renderSubjectCard({ subjectId: 1, name: payload, progress: 0 }),
      renderers.renderCalendar([{ weekday: { id: 1, cn: payload, en: payload }, items: [] }]),
    ]
    for (const output of outputs) {
      assert.doesNotMatch(output, /<script|<img|["']\s(?:onerror|onmouseover)=/i)
      assert.doesNotMatch(output, /(?:href|src)=["']javascript:/i)
    }
  }
})

test('production widget renderers reject non-finite scores in cards', () => {
  const renderers = loadWidgetProductionRenderers()
  assert.doesNotMatch(renderers.renderSubjectCard({ subjectId: 1, name: 'non-finite', score: Number.POSITIVE_INFINITY }), /Infinity/)
})

test('widget rejects dangerous URLs and contains no inline click handlers', () => {
  const { safeUrl } = loadWidgetSecurityHelpers()
  const fixture = '<a href="' + safeUrl('javascript:alert(1)', '#') + '">link</a>'
  assert.doesNotMatch(fixture, /(?:href|src)=["']javascript:/i)
  assert.doesNotMatch(widgetJs, /\sonclick\s*=/i)
  assert.doesNotMatch(widgetJs, /\.onclick\s*=/)
  assert.match(widgetJs, /addEventListener\(['"]click['"]/)
})

test('production widget renderers reject blob and data URLs in image sinks', () => {
  const renderers = loadWidgetProductionRenderers()
  const imageHtml = renderers.renderSubjectCard({
    subjectId: 1,
    name: 'unsafe cover',
    images: { common: { uri: 'blob:https://widget.example/secret' } },
  })

  assert.doesNotMatch(imageHtml, /src=["'](?:blob|data):/i)
})

test('pages load cacheJs which fills the footer runtime status slot from health', () => {
  assert.match(renderIndexPage(), /<script src="\/src\/cache\.js"><\/script>/)
  assert.match(cacheJs, /\/api\/health/)
  assert.match(cacheJs, /data-runtime-status/)
  assert.match(cacheJs, /response\.ok/)
  assert.match(cacheJs, /Next .*escapeHtml\(nextCron\)/)
  assert.match(cacheJs, /Last .*escapeHtml\(lastStatus/)
  assert.match(cacheJs, /cron\.scheduler/)
  assert.match(cacheJs, /setInterval/)
  assert.match(cacheJs, /refreshRuntimeStatus/)
  assert.match(cacheJs, /Date\.now/)
  assert.match(cacheJs, /inFlight/)
})

test('widgetCss styles the shared footer', () => {
  assert.match(widgetCss, /\.bgm-footer\s*\{/)
  assert.match(widgetCss, /\.bgm-footer a\s*\{/)
})

test('widgetCss styles footer cache statistics', () => {
  assert.match(widgetCss, /\.bgm-footer-cache\s*\{/)
  assert.match(widgetCss, /\.bgm-footer-cache span\s*\{/)
})

test('packaged widget assets do not read legacy image hash fields', () => {
  for (const asset of ['assets/theme/bangumi.js', 'assets/theme/cache.js', 'src/generated-assets.ts']) {
    const source = readFileSync(resolve(widgetRoot, asset), 'utf8')
    assert.equal(source.includes('images.hash'), false, `${asset} should not read images.hash`)
    assert.equal(source.includes('hash_large'), false, `${asset} should not read hash_large`)
    assert.equal(source.includes('data:image'), false, `${asset} should not embed a base64/data URI cover fallback`)
    assert.equal(source.includes("'??') + ' 话'"), false, `${asset} should not render unknown calendar totals as question marks`)
    if (asset.endsWith('bangumi.js')) {
      assert.equal(source.includes("'集数待定'"), true, `${asset} should render a stable pending label for unknown calendar totals`)
    }
  }
})
