import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// Reuse Wrangler's installed runtime and bundler; no cloud credentials or upstream calls.
const wrangler = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'))
const { Miniflare } = wrangler('miniflare')
const { build } = wrangler('esbuild')

test('three Worker entrypoints start and serve the R2 publication through service bindings', async () => {
  const workers = await Promise.all(['frontend', 'read', 'sync'].map(async name => {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL(`../apps/${name}-worker/src/index.ts`, import.meta.url))], bundle: true, format: 'esm', write: false })
    return { name, modules: true, compatibilityDate: '2026-06-17', script: bundle.outputFiles[0].text }
  }))
  workers[0].serviceBindings = { READ_WORKER: 'read', SYNC_WORKER: 'sync' }
  workers[1].r2Buckets = ['AIRING_CAL_DATA_R2', 'AIRING_CAL_R2']
  workers[2].d1Databases = ['AIRING_CAL_D1']
  const runtime = new Miniflare({ workers })
  try {
    assert.equal((await runtime.dispatchFetch('https://p2.local/')).status, 200)
    assert.equal((await runtime.dispatchFetch('https://p2.local/api/manifest')).status, 503)
    const invalid = await runtime.dispatchFetch('https://p2.local/api/sync/apply', { method: 'POST', body: 'null' })
    assert.equal(invalid.status, 400)
    // Canonical order is deliberate: this is the smallest valid public snapshot payload.
    const payload = { calendar: [], collections: { dropped: [], on_hold: [], want: [], watched: [], watching: [] }, schema_version: 1, summary: { _total: 0, dropped: 0, on_hold: 0, want: 0, watched: 0, watching: 0 } }
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const key = `snapshots/v1/1-${hash}.json`
    const snapshot = { ...payload, generation: 1, published_at: 100, content_hash: hash }
    const pointer = { schema_version: 1, generation: 1, snapshot_key: key, content_sha256: hash, published_at: new Date(100000).toISOString(), source_observed_at: new Date(100000).toISOString(), item_count: 0, git_sha: 'a'.repeat(40) }
    const bucket = await runtime.getR2Bucket('AIRING_CAL_DATA_R2', 'read')
    await bucket.put(key, JSON.stringify(snapshot))
    await bucket.put('public/manifest.json', JSON.stringify(pointer))
    const latest = await runtime.dispatchFetch('https://p2.local/api/manifest')
    assert.equal(latest.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await latest.json(), pointer)
    const version = await runtime.dispatchFetch('https://p2.local/api/' + key)
    assert.equal(version.status, 200)
    assert.match(version.headers.get('cache-control'), /immutable/)
    assert.deepEqual(await version.json(), snapshot)
    await bucket.delete(key)
    assert.equal((await runtime.dispatchFetch('https://p2.local/api/' + key)).status, 200)
    await bucket.put('public/manifest.json', JSON.stringify({ ...pointer, source_observed_at: new Date(200000).toISOString() }))
    assert.equal((await (await runtime.dispatchFetch('https://p2.local/api/manifest')).json()).source_observed_at, new Date(200000).toISOString())
  } finally { await runtime.dispose() }
})
