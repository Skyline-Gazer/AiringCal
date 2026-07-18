import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

function env() {
  const calls: string[] = []
  const syncCalls: Array<{ path: string; method: string; body: string }> = []
  return {
    calls,
    syncCalls,
    READ_WORKER: {
      fetch: async (request: Request) => {
        const url = new URL(request.url)
        calls.push(url.pathname + url.search)
        if (url.pathname.startsWith('/image/')) {
          return new Response('image-bytes', { headers: { 'Content-Type': 'image/png' } })
        }
        return Response.json({ path: url.pathname, search: url.search })
      },
    },
    SYNC_WORKER: {
      fetch: async (request: Request) => {
        const url = new URL(request.url)
        syncCalls.push({ path: url.pathname + url.search, method: request.method, body: await request.text() })
        return Response.json({ path: url.pathname, method: request.method }, {
          headers: { 'X-Sync-Operation-Id': 'op-1' },
        })
      },
    },
    BANGUMI_GIT_COMMIT_SHA: '0123456789abcdef',
    BANGUMI_GIT_REPOSITORY_URL: 'https://github.com/markd3ng/AiringCal',
  }
}

test('frontend-worker serves index without cache page link and removes cache HTML page', async () => {
  const appEnv = env()
  const index = await worker.fetch(new Request('https://front.local/'), appEnv as any)
  const cache = await worker.fetch(new Request('https://front.local/cache'), appEnv as any)
  const indexHtml = await index.text()

  assert.equal(indexHtml.includes('href="/cache"'), false)
  assert.match(indexHtml, /Build 0123456/)
  assert.equal(cache.status, 404)
})

test('frontend-worker protects HTML responses without applying HTML CSP to assets', async () => {
  const html = await worker.fetch(new Request('https://front.local/'), env() as any)
  const js = await worker.fetch(new Request('https://front.local/src/bangumi.js'), env() as any)
  const css = await worker.fetch(new Request('https://front.local/src/bangumi.css'), env() as any)

  assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(html.headers.get('x-frame-options'), 'DENY')
  assert.match(html.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/)
  assert.match(html.headers.get('content-security-policy') ?? '', /base-uri 'none'/)
  assert.doesNotMatch(html.headers.get('content-security-policy') ?? '', /script-src[^;]*'unsafe-inline'/)
  assert.equal(js.headers.get('content-security-policy'), null)
  assert.equal(css.headers.get('content-security-policy'), null)
})

test('frontend-worker serves widget assets from widget package', async () => {
  const js = await worker.fetch(new Request('https://front.local/src/bangumi.js'), env() as any)
  const css = await worker.fetch(new Request('https://front.local/src/bangumi.css'), env() as any)
  const cache = await worker.fetch(new Request('https://front.local/src/cache.js'), env() as any)

  assert.equal(js.headers.get('Content-Type'), 'application/javascript; charset=utf-8')
  const jsBody = await js.text()
  assert.match(jsBody, /images\?\.common\?\.uri/)
  assert.equal(jsBody.includes("'??') + ' 话'"), false)
  assert.equal(css.headers.get('Content-Type'), 'text/css; charset=utf-8')
  assert.equal(cache.headers.get('Content-Type'), 'application/javascript; charset=utf-8')
  assert.match(await cache.text(), /\/api\/health/)
})

test('frontend-worker forwards public JSON reads to read-worker service binding', async () => {
  const appEnv = env()
  const response = await worker.fetch(new Request('https://front.local/api/collections?type=watching'), appEnv as any)
  const body = await response.json() as any

  assert.deepEqual(appEnv.calls, ['/collections?type=watching'])
  assert.equal(body.path, '/collections')
  assert.equal(body.search, '?type=watching')
})

test('frontend-worker delegates image route to read-worker service binding', async () => {
  const appEnv = env()
  const response = await worker.fetch(new Request(`https://front.local/image/${'a'.repeat(64)}`), appEnv as any)

  assert.deepEqual(appEnv.calls, [`/image/${'a'.repeat(64)}`])
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.equal(await response.text(), 'image-bytes')
})

test('frontend-worker forwards public sync routes to sync-worker internal routes', async () => {
  const appEnv = env()
  const apply = await worker.fetch(new Request('https://front.local/api/sync/apply', {
    method: 'POST',
    body: JSON.stringify({ mode: 'partial' }),
  }), appEnv as any)
  const check = await worker.fetch(new Request('https://front.local/api/check/mabc-0123456789abcdef?format=json'), appEnv as any)

  assert.equal(apply.headers.get('X-Sync-Operation-Id'), 'op-1')
  assert.deepEqual(appEnv.syncCalls, [
    { path: '/internal/sync/apply', method: 'POST', body: JSON.stringify({ mode: 'partial' }) },
    { path: '/internal/check/mabc-0123456789abcdef?format=json', method: 'GET', body: '' },
  ])
  assert.equal((await check.json() as any).path, '/internal/check/mabc-0123456789abcdef')
})
