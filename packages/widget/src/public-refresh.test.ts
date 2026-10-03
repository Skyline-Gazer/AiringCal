import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('browser serializes refreshes, switches whole generations and retains content after failures', async () => {
  const source = readFileSync(new URL('../assets/theme/bangumi.js', import.meta.url), 'utf8')
  const reader = source.slice(source.indexOf('  var snapshot = null'), source.indexOf('  function publicMessage()'))
  let generation = 1, failVersion = false
  let versionReads = 0
  const hash = (n: number) => String(n).repeat(64)
  const fakeFetch = async (url: string) => {
    if (url.endsWith('/status')) return Response.json(null)
    if (url.endsWith('/manifest')) return Response.json({ schema_version: 1, generation,
      content_sha256: hash(generation), snapshot_key: `snapshots/v1/${generation}-${hash(generation)}.json`,
      published_at: new Date(100000).toISOString(), item_count: 0,
    })
    versionReads++
    if (failVersion) return new Response('', { status: 503 })
    return Response.json({ schema_version: 1, generation, content_hash: hash(generation),
      published_at: 100, collections: {}, calendar: [], summary: { _total: 0 },
    })
  }
  const client = Function('fetch', 'window', 'API', `${reader}
    return { refresh: refreshSnapshot, state: () => ({ snapshot, latestManifest, refreshError }) }`
  )(fakeFetch, { dispatchEvent() {} }, '')
  const first = client.refresh()
  assert.equal(client.refresh(), first)
  await first
  assert.equal(client.state().snapshot.generation, 1)
  assert.equal(versionReads, 1)
  generation = 2; failVersion = true
  await client.refresh()
  assert.equal(client.state().snapshot.generation, 1)
  assert.ok(client.state().refreshError)
  failVersion = false
  await client.refresh()
  assert.equal(client.state().snapshot.generation, 2)
  assert.equal(client.state().latestManifest.generation, 2)
  generation = 1
  await client.refresh()
  assert.equal(client.state().snapshot.generation, 2)
  const before = versionReads
  generation = 2
  await client.refresh()
  assert.equal(versionReads, before)
})
