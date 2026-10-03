import assert from 'node:assert/strict'
import test from 'node:test'
import { buildManifest, buildPublicSnapshot, executeSync, WatchStatus } from '@airing-cal/domain'
import read from './index.ts'
import { snapshotResponse } from './r2-snapshot.ts'
import frontend from '../../frontend-worker/src/index.ts'
import sync from '../../sync-worker/src/index.ts'

// Offline only: no Cloudflare credentials, upstream requests or deployed resources.
test('latest pointer advances independently of immutable cached snapshots and bounded account requests', async () => {
  const snapshot = await buildPublicSnapshot({ collections: [], calendar: [], published_at: 100 }, 1)
  const pointer = buildManifest(snapshot, { source_observed_at: new Date(100000).toISOString(), git_sha: 'a'.repeat(40) })
  const objects = new Map<string, string>([
    ['public/manifest.json', JSON.stringify(pointer)], [pointer.snapshot_key, JSON.stringify(snapshot)],
  ])
  let reads = 0
  const bucket = { async get(key: string) { reads++; const value = objects.get(key); return value === undefined ? null : { async text() { return value } } } }
  const cached = new Map<string, Response>()
  const cache = {
    async match(request: Request) { return cached.get(request.url)?.clone() },
    async put(request: Request, response: Response) { cached.set(request.url, response.clone()) },
  }
  const version = await snapshotResponse(pointer.snapshot_key, bucket, cache, 'https://front.local')
  assert.match(version.headers.get('cache-control')!, /immutable/)
  const before = reads
  assert.equal((await snapshotResponse(pointer.snapshot_key, bucket, cache, 'https://front.local')).status, 200)
  assert.equal(reads, before)
  const env = { AIRING_CAL_DATA_R2: bucket, AIRING_CAL_R2: { async get() { return null } } }
  const frontEnv = { READ_WORKER: { fetch: (request: Request) => read.fetch(request, env) }, SYNC_WORKER: { fetch: async () => new Response() } }
  const latest = await frontend.fetch(new Request('https://front.local/api/manifest'), frontEnv)
  assert.equal(latest.headers.get('cache-control'), 'no-store')
  assert.equal((await latest.json() as typeof pointer).generation, 1)
  objects.set('public/manifest.json', JSON.stringify({ ...pointer, source_observed_at: new Date(200000).toISOString() }))
  assert.equal((await (await read.fetch(new Request('https://front.local/manifest'), env)).json() as typeof pointer).source_observed_at, new Date(200000).toISOString())
  objects.set(pointer.snapshot_key, JSON.stringify({ ...snapshot, summary: { ...snapshot.summary, _total: 1 } }))
  await assert.rejects(snapshotResponse(pointer.snapshot_key, bucket, { match: async () => undefined, put: async () => {} }, 'https://fresh.local'))
  assert.equal((await read.fetch(new Request('https://front.local/collections?type=__proto__'), env)).status >= 400, true)
  const invalid = await sync.fetch(new Request('https://front.local/internal/sync/apply', { method: 'POST', body: 'null' }), {} as never)
  assert.equal(invalid.status, 400)
  assert.equal(invalid.headers.get('cache-control'), 'no-store')
  assert.equal('scheduled' in sync, false)
  assert.equal('queue' in sync, false)
  await assert.rejects(executeSync({} as never, 'a', {} as never, 'b', { mode: 'full', from: 'A', to: 'B' }))
  const patched: string[] = []
  const client = {
    platform: 'bgm' as const,
    async getMe() { return { username: 'source', externalId: '1', platform: 'bgm' as const } },
    async fetchCollections() { return ['1', '2'].map(externalId => ({ externalId, title: externalId, status: WatchStatus.WATCHING, progress: 0, totalEpisodes: 1, score: 0, platform: 'bgm' as const })) },
    async patchEntry(_token: string, id: string) { patched.push(id); return { episodeChanged: 0 } },
  }
  await executeSync(client, 'a', client, 'b', { mode: 'full', from: 'A', to: 'B', subject_ids: ['1'] })
  assert.deepEqual(patched, ['1'])
})
