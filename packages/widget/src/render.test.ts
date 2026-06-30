import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  renderCachePage,
  renderFooter,
  renderIndexPage,
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

test('widgetJs consumes new images.common.uri shape', () => {
  assert.match(widgetJs, /images\?\.common\?\.uri/)
  assert.match(widgetJs, /document\.querySelector\('\.bgm-container'\)/)
  assert.equal(widgetJs.includes('hash_large'), false)
})

test('widgetJs uses eps as the collection total episode fallback', () => {
  assert.match(widgetJs, /entry\.eps \|\| entry\.total_episodes/)
})

test('widgetJs renders text when image cache is unavailable instead of a data URI placeholder', () => {
  assert.match(widgetJs, /image cache failed/)
  assert.equal(widgetJs.includes('data:image'), false)
})

test('widgetCss styles the shared footer', () => {
  assert.match(widgetCss, /\.bgm-footer\s*\{/)
  assert.match(widgetCss, /\.bgm-footer a\s*\{/)
})

test('packaged widget assets do not read legacy image hash fields', () => {
  for (const asset of ['assets/public/src/bangumi.js', 'assets/theme/bangumi.js', 'assets/theme/v1/bangumi.js']) {
    const source = readFileSync(resolve(widgetRoot, asset), 'utf8')
    assert.equal(source.includes('images.hash'), false, `${asset} should not read images.hash`)
    assert.equal(source.includes('hash_large'), false, `${asset} should not read hash_large`)
    assert.equal(source.includes('data:image'), false, `${asset} should not embed a base64/data URI cover fallback`)
  }
})
