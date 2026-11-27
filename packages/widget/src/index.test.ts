import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInfo, renderIndexPage, widgetCss, widgetJs } from './index.ts'

test('standalone shell loads the stable widget assets and build stamp', () => {
  const html = renderIndexPage({ commitSha: 'abc1234def' })
  assert.match(html, /<div class="bgm-container" data-bgm-standalone="1"><\/div>/)
  assert.match(html, /<link rel="stylesheet" href="\/src\/bangumi\.css">/)
  assert.match(html, /<script src="\/src\/bangumi\.js"><\/script>/)
  assert.match(html, /body class="bgm-page"/)
  const stamp = html.match(/window\.__AIRINGCAL_BUILD__=(\{.*?\})<\/script>/)
  assert.ok(stamp, 'shell must expose the build stamp')
  const parsed = JSON.parse(stamp[1]) as { commitSha: string; builtAt: string; contentHash: string }
  assert.equal(parsed.commitSha, 'abc1234def')
  assert.equal(parsed.builtAt, buildInfo.builtAt)
  assert.equal(parsed.contentHash, buildInfo.contentHash)
})

test('shell keeps no legacy cache helper or server-rendered footer', () => {
  const html = renderIndexPage()
  assert.doesNotMatch(html, /cache\.js/)
  assert.doesNotMatch(html, /Next Writer|Last Writer|已连接/)
  assert.doesNotMatch(html, /bgm-footer/)
})

test('widget assets are a classic script plus one stylesheet', () => {
  assert.ok(widgetJs.length > 1000)
  assert.ok(widgetCss.includes('.bgm-container'))
  assert.match(widgetJs, /^\(function\(\)\{/)
})
