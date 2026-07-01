import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cacheJs,
  renderCachePage,
  renderFooter,
  renderIndexPage,
  renderAnalyticsScripts,
  renderWebmasterMeta,
  widgetJs,
  widgetCss,
} from './index.ts'

const widgetRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('renderFooter links cache page and commit when SHA and repository are present', () => {
  const footer = renderFooter({
    commitSha: '0123456789abcdef',
    repositoryUrl: 'https://github.com/markd3ng/AiringCal',
  })

  assert.match(footer, /href="\/cache"/)
  assert.match(footer, /Build 0123456/)
  assert.match(footer, /https:\/\/github.com\/markd3ng\/AiringCal\/commit\/0123456789abcdef/)
})

test('renderFooter falls back to Build unknown without commit link', () => {
  const footer = renderFooter({})

  assert.match(footer, /Build unknown/)
  assert.equal(footer.includes('/commit/'), false)
})

test('public pages reuse the exact shared footer output', () => {
  const build = { commitSha: 'abcdef0123456789', repositoryUrl: 'https://github.com/markd3ng/AiringCal' }
  const footer = renderFooter(build)

  assert.equal(renderIndexPage({ build }).includes(footer), true)
  assert.equal(renderCachePage({ build }).includes(footer), true)
})

test('renderFooter exposes an inline cache statistics slot', () => {
  const footer = renderFooter({})

  assert.match(footer, /href="\/cache"/)
  assert.match(footer, /data-cache-stats/)
  assert.match(footer, /Cache loading/)
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

test('widgetJs renders precise cache status text when image cache is unavailable', () => {
  assert.match(widgetJs, /entry\.image_status/)
  assert.match(widgetJs, /imageStatus\?\.common/)
  assert.match(widgetJs, /image pending/)
  assert.match(widgetJs, /image missing source/)
  assert.match(widgetJs, /image cache failed/)
  assert.equal(widgetJs.includes('data:image'), false)
})

test('widgetJs includes animation sync UI and public sync endpoints', () => {
  assert.match(widgetJs, /动画同步/)
  assert.match(widgetJs, /\/api\/sync\/compare/)
  assert.match(widgetJs, /\/api\/sync\/apply/)
  assert.match(widgetJs, /\/api\/check\//)
})

test('pages load cacheJs which fills the footer cache statistics slot', () => {
  assert.match(renderIndexPage(), /<script src="\/src\/cache\.js"><\/script>/)
  assert.match(renderCachePage(), /<script src="\/src\/cache\.js"><\/script>/)
  assert.doesNotMatch(renderCachePage(), /<main class="bgm-cache-page">/)
  assert.match(cacheJs, /\/api\/cache/)
  assert.match(cacheJs, /data-cache-stats/)
  assert.match(cacheJs, /response\.ok/)
  assert.match(cacheJs, /Common cached/)
  assert.match(cacheJs, /Large cached/)
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
  for (const asset of ['assets/public/src/bangumi.js', 'assets/theme/bangumi.js', 'assets/theme/cache.js', 'assets/theme/v1/bangumi.js']) {
    const source = readFileSync(resolve(widgetRoot, asset), 'utf8')
    assert.equal(source.includes('images.hash'), false, `${asset} should not read images.hash`)
    assert.equal(source.includes('hash_large'), false, `${asset} should not read hash_large`)
    assert.equal(source.includes('data:image'), false, `${asset} should not embed a base64/data URI cover fallback`)
  }
})
