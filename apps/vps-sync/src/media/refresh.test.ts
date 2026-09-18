import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshMedia, type MediaDependencies } from './refresh.js'

const at = '2026-08-31T00:00:00.000Z'
const context = { runId: 'new', observedAt: at, mode: 'shadow', source: 'manual' } as const
const oldRef = { hash: 'old', uri: '/image/old', r2_key: 'images/old/original' }

function fixture(current: any = null) {
  const events: string[] = []
  const saves: any[] = []
  const deps: MediaDependencies = {
    list: async () => [{ subjectId: 1, priority: 'new_or_changed' }],
    withSubject: async (_id, work) => {
      events.push('lock')
      try {
        return await work({
          current,
          save: async (value) => { events.push('save'); saves.push(value); return true },
        })
      } finally { events.push('unlock') }
    },
    detail: async () => ({ id: 1, name: 'subject', nsfw: false, images: { common: 'https://lain.bgm.tv/pic/cover/l/a.jpg' }}),
    image: async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }),
    put: async (key) => { events.push(`put:${key}`) },
  }
  return { deps, events, saves }
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    subjectId: 1, runId: 'old', observedAt: '2026-08-01T00:00:00.000Z', detail: { id: 1, name: 'old' }, metadata: null,
    imageRefs: { common: oldRef, large: oldRef }, detailHash: 'old', metadataHash: null, imageHash: 'old', status: { detail: 'success', image: 'success' },
    nextRetryAt: null, deletedAt: null, lastSuccessAt: null, ...overrides,
  }
}

test('holds subject lock across R2 PUT and reference commit; shadow keys never target live', async () => {
  const { deps, events, saves } = fixture()
  assert.deepEqual(await refreshMedia(deps, context), { selected: 1, succeeded: 1, failed: 0 })
  assert.match(events[1]!, /^put:shadow\/images\/[a-f0-9]{64}\/original$/)
  assert.deepEqual(events.slice(2), ['save', 'unlock'])
  assert.equal(saves[0]?.status.metadata, 'success')
})

test('transient image failure retains each last-known-good size while detail succeeds', async () => {
  const { deps, saves } = fixture(stored())
  deps.image = async () => new Response('unavailable', { status: 503 })
  assert.equal((await refreshMedia(deps, context)).failed, 1)
  assert.deepEqual(saves[0]?.imageRefs, { common: oldRef, large: oldRef })
  assert.equal(saves[0]?.detail?.name, 'subject')
  assert.equal(saves[0]?.status.metadata, 'success')
  assert.equal(Date.parse(saves[0]!.nextRetryAt!) - Date.parse(at), 3_600_000)
  assert.equal(saves[0]?.status.image, 'failed')
})

test('records stable error codes for image failures without exception details', async () => {
  const cases = [
    ['server', 'UPSTREAM_SERVER', (deps: MediaDependencies) => { deps.image = async () => new Response('private server body', { status: 503 }) }],
    ['rate limit', 'UPSTREAM_RATE_LIMIT', (deps: MediaDependencies) => { deps.image = async () => new Response('private limit body', { status: 429 }) }],
    ['network', 'UPSTREAM_NETWORK', (deps: MediaDependencies) => { deps.image = async () => { throw new TypeError('private network details') } }],
    ['invalid MIME', 'MEDIA_INVALID', (deps: MediaDependencies) => { deps.image = async () => new Response('private HTML body', { headers: { 'content-type': 'text/html' } }) }],
    ['R2 upload', 'MEDIA_UPLOAD', (deps: MediaDependencies) => { deps.put = async () => { throw new Error('private R2 details') } }],
  ] as const

  for (const [name, errorCode, configure] of cases) {
    const { deps, saves } = fixture(stored())
    configure(deps)
    await refreshMedia(deps, context)
    assert.equal(saves[0]?.errorCode, errorCode, name)
    assert.doesNotMatch(JSON.stringify(saves[0]), /private/)
  }
})

test('expired not-found metadata is not renewed after a transient detail error', async () => {
  const expired = '2026-08-30T00:00:00.000Z'
  const { deps, saves } = fixture(stored({
    metadata: { exists: false, nsfw: true, checked_at: 1, expires_at: 1, reason: 'not_found' },
    status: { detail: 'not_found', metadata: 'success', image: 'not_found' },
    deletedAt: expired,
    nextRetryAt: expired,
  }))
  deps.detail = async () => { throw new TypeError('fetch failed') }
  assert.equal((await refreshMedia(deps, context)).failed, 1)
  assert.equal(saves[0]?.detail?.name, 'old')
  assert.deepEqual(saves[0]?.imageRefs, { common: oldRef, large: oldRef })
  assert.equal(saves[0]?.metadata?.exists, false)
  assert.equal(saves[0]?.status.detail, 'failed')
  assert.equal(saves[0]?.status.metadata, 'failed')
  assert.equal(saves[0]?.deletedAt, null)
  assert.equal(Date.parse(saves[0]!.nextRetryAt!) - Date.parse(at), 3_600_000)
})

test('invalid image content remains a slow refresh while network errors retry quickly', async () => {
  const invalid = fixture(stored())
  invalid.deps.image = async () => new Response('not an image', { headers: { 'content-type': 'text/html' } })
  await refreshMedia(invalid.deps, context)
  assert.ok(Date.parse(invalid.saves[0]!.nextRetryAt!) - Date.parse(at) >= 6 * 86_400_000)
  assert.equal(invalid.saves[0]?.status.image, 'failed')

  const network = fixture(stored())
  network.deps.image = async () => { throw new TypeError('fetch failed') }
  await refreshMedia(network.deps, context)
  assert.equal(Date.parse(network.saves[0]!.nextRetryAt!) - Date.parse(at), 3_600_000)
  assert.equal(network.saves[0]?.status.detail, 'success')
  assert.equal(network.saves[0]?.status.metadata, 'success')
  assert.equal(network.saves[0]?.status.image, 'failed')
})

test('detail 404 keeps existing public data and sets a bounded tombstone; TTL skips upstream', async () => {
  const { deps, saves } = fixture(stored())
  deps.detail = async () => null
  await refreshMedia(deps, context)
  assert.equal(saves[0]?.detail?.name, 'old')
  assert.equal(saves[0]?.metadata?.exists, false)
  assert.equal(Date.parse(saves[0]!.nextRetryAt!) - Date.parse(at), 86_400_000)
  const next = fixture(saves[0])
  next.deps.detail = async () => { throw new Error('must not fetch') }
  assert.equal((await refreshMedia(next.deps, context)).failed, 0)
  assert.equal(next.saves.length, 0)
})

test('obsolete and completed same-run fences prevent download, PUT and database mutation', async () => {
  for (const current of [stored({ observedAt: '2026-09-01T00:00:00Z' }), stored({ observedAt: at, runId: context.runId })]) {
    const { deps, events, saves } = fixture(current)
    deps.detail = async () => { throw new Error('must not fetch') }
    await refreshMedia(deps, context)
    assert.deepEqual(events, ['lock', 'unlock'])
    assert.equal(saves.length, 0)
  }
})

test('same bytes reuse same namespace; shadow bytes are uploaded when switching to live', async () => {
  const first = fixture()
  await refreshMedia(first.deps, context)
  const current = first.saves[0]!
  const again = fixture({ ...current, observedAt: '2026-08-01T00:00:00Z', runId: 'old', nextRetryAt: null })
  await refreshMedia(again.deps, context)
  assert.ok(!again.events.some((event) => event.startsWith('put:')))
  const live = fixture({ ...current, observedAt: '2026-08-01T00:00:00Z', runId: 'old', nextRetryAt: null })
  await refreshMedia(live.deps, { ...context, mode: 'live' })
  assert.ok(live.events.some((event) => event.startsWith('put:images/')))
})

test('rejects invalid image MIME, HTTP, size and unsafe URLs before storing', async () => {
  for (const response of [
    new Response('html', { headers: { 'content-type': 'text/html' } }),
    new Response('x', { status: 403 }),
    new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ]) {
    const { deps, events } = fixture()
    deps.image = async () => response
    assert.equal((await refreshMedia(deps, context)).failed, 1)
    assert.ok(!events.some((event) => event.startsWith('put:')))
  }
  const { deps, events } = fixture()
  deps.detail = async () => ({ id: 1, name: 'x', images: { common: 'http://127.0.0.1/secret' } })
  deps.image = async () => { throw new Error('must not fetch') }
  assert.equal((await refreshMedia(deps, context)).failed, 1)
  assert.ok(!events.some((event) => event.startsWith('put:')))
})

test('missing source does not fail metadata or erase old image references', async () => {
  const { deps, saves } = fixture(stored())
  deps.detail = async () => ({ id: 1, name: 'subject' })
  assert.equal((await refreshMedia(deps, context)).failed, 0)
  assert.equal(saves[0]?.status.image, 'missing')
  assert.equal(saves[0]?.status.metadata, 'success')
  assert.deepEqual(saves[0]?.imageRefs, { common: oldRef, large: oldRef })
})

test('bounded concurrency drains all in-flight work even if a save fails', async () => {
  const { deps } = fixture()
  let active = 0
  let maximum = 0
  deps.list = async () => Array.from({ length: 20 }, (_, index) => ({ subjectId: index + 1, priority: 'hot' as const }))
  deps.withSubject = async (_id, work) => {
    active++
    maximum = Math.max(maximum, active)
    try { return await work({ current: null, save: async () => { throw new Error('DB') } }) }
    finally { active-- }
  }
  assert.equal((await refreshMedia(deps, context)).failed, 20)
  assert.ok(maximum <= 4)
  assert.equal(active, 0)
})

test('two sizes with identical content PUT the content object once', async () => {
  const { deps, events } = fixture()
  deps.detail = async () => ({ id: 1, name: 'x', images: { common: 'https://lain.bgm.tv/a', large: 'https://lain.bgm.tv/b' } })
  await refreshMedia(deps, context)
  assert.equal(events.filter((event) => event.startsWith('put:')).length, 1)
})

test('priority ordering is stable, duplicate IDs preserve strongest priority, cold uses weekday shard', async () => {
  const { deps } = fixture()
  const ids: number[] = []
  deps.list = async () => [
    { subjectId: 2, priority: 'retry' }, { subjectId: 1, priority: 'new_or_changed' },
    { subjectId: 1, priority: 'retry' }, { subjectId: 3, priority: 'cold' }, { subjectId: 8, priority: 'cold' },
  ]
  deps.withSubject = async (id) => { ids.push(id); return undefined }
  await refreshMedia(deps, context)
  assert.deepEqual(ids, [1, 8, 2])
})
