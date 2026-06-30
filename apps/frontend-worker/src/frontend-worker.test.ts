import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.ts'

function env() {
  const calls: string[] = []
  return {
    calls,
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
    BANGUMI_GIT_COMMIT_SHA: '0123456789abcdef',
    BANGUMI_GIT_REPOSITORY_URL: 'https://github.com/markd3ng/AiringCal',
  }
}

test('frontend-worker serves index and cache HTML with shared footer', async () => {
  const appEnv = env()
  const index = await worker.fetch(new Request('https://front.local/'), appEnv as any)
  const cache = await worker.fetch(new Request('https://front.local/cache'), appEnv as any)

  assert.match(await index.text(), /href="\/cache"/)
  assert.match(await cache.text(), /Build 0123456/)
})

test('frontend-worker serves widget assets from widget package', async () => {
  const js = await worker.fetch(new Request('https://front.local/src/bangumi.js'), env() as any)
  const css = await worker.fetch(new Request('https://front.local/src/bangumi.css'), env() as any)

  assert.equal(js.headers.get('Content-Type'), 'application/javascript; charset=utf-8')
  assert.match(await js.text(), /images\?\.common\?\.uri/)
  assert.equal(css.headers.get('Content-Type'), 'text/css; charset=utf-8')
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
