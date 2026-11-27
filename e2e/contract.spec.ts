import { expect, test } from '@playwright/test'

test('static surface keeps the documented content types, cache policy and removals', async ({ request }) => {
  const index = await request.get('/')
  expect(index.status()).toBe(200)
  expect(index.headers()['content-type']).toContain('text/html')
  expect(index.headers()['cache-control']).toBe('public, max-age=300')
  expect(await index.text()).toContain('/src/bangumi.js')

  const js = await request.get('/src/bangumi.js')
  expect(js.headers()['content-type']).toContain('application/javascript')
  expect(js.headers()['cache-control']).toBe('public, max-age=300')

  const css = await request.get('/src/bangumi.css')
  expect(css.headers()['content-type']).toContain('text/css')
  expect(css.headers()['cache-control']).toBe('public, max-age=300')

  expect((await request.get('/src/cache.js')).status()).toBe(404)
  expect((await request.get('/api/sync/apply')).status()).toBe(410)
  expect((await request.get('/checkpoints/latest.sqlite')).status()).toBe(404)
})

test('NSFW filtering changes totals and the ETag, and rejects junk values', async ({ request }) => {
  const all = await request.get('/api/collections?type=watching&limit=100')
  const hidden = await request.get('/api/collections?type=watching&limit=100&nsfw=hide')
  const shown = await request.get('/api/collections?type=watching&limit=100&nsfw=show')

  expect(all.status()).toBe(200)
  expect((await all.json()).total).toBe(55)
  expect((await shown.json()).total).toBe(55)
  expect((await hidden.json()).total).toBe(52)

  expect(hidden.headers()['etag']).not.toBe(all.headers()['etag'])
  expect(shown.headers()['etag']).toBe(all.headers()['etag'])

  const invalid = await request.get('/api/collections?type=watching&nsfw=maybe')
  expect(invalid.status()).toBe(400)
  expect((await invalid.json()).error.code).toBe('INVALID_QUERY')

  const conditional = await request.get('/api/collections?type=watching&limit=100&nsfw=hide', {
    headers: { 'If-None-Match': hidden.headers()['etag'] },
  })
  expect(conditional.status()).toBe(304)
})

test('page size follows the requested limit for the shared widget contract', async ({ request }) => {
  const body = await (await request.get('/api/collections?type=watching&page=2&limit=18&nsfw=hide')).json() as {
    data: unknown[]
    total: number
    page: number
    limit: number
  }
  expect(body.limit).toBe(18)
  expect(body.page).toBe(2)
  expect(body.data.length).toBe(18)
  expect(body.total).toBe(52)
})

test('reader errors stay JSON and leave the store untouched', async ({ request }) => {
  const response = await request.get('/api/collections?type=nope')
  expect(response.status()).toBe(400)
  expect((await response.json()).error.code).toBe('INVALID_QUERY')
})
