import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import test from 'node:test'
import type { CompareResult, SyncResult } from '@airing-cal/domain'
import type { D1DatabaseLike } from '@airing-cal/storage'
import sync from './index.ts'

function collection(id: number, type = 3, rate = 7, progress = 1, title = `Anime ${id}`) {
  return {
    subject_id: id, subject_type: 2, type, rate, ep_status: progress, vol_status: 0,
    comment: '', tags: [], updated_at: '2026-10-01T00:00:00Z', private: false,
    subject: {
      id, type: 2, name: title, name_cn: title, short_summary: '', tags: [], score: 7,
      eps: 2, volumes: 0, collection_total: 1, rank: 1,
      images: { large: '', common: '', medium: '', small: '', grid: '' },
    },
  }
}

// Offline: actual worker, platform client, domain logic and migration; only outbound HTTP is mocked.
test('account compare/apply/check uses bounded selections, SQLite logs and redacted errors', async () => {
  const db = new DatabaseSync(':memory:')
  db.exec(readFileSync(new URL('../../../migrations/0003_account_operations.sql', import.meta.url), 'utf8'))
  const env = {
    // ponytail: only bind/first/run are consumed here; add D1 methods if this worker starts using them.
    AIRING_CAL_D1: {
      prepare(query: string) {
        const statement = db.prepare(query)
        let parameters: SQLInputValue[] = []
        const bound = {
          bind(...values: SQLInputValue[]) { parameters = values; return bound },
          async first<T>() { return (statement.get(...parameters) as T | undefined) ?? null },
          async run() { return statement.run(...parameters) },
        }
        return bound
      },
    } as unknown as D1DatabaseLike,
  }
  const rowCount = () => db.prepare('SELECT COUNT(*) AS count FROM airingcal_operations').get()!.count
  const post = (route: string, body: unknown) => sync.fetch(new Request(`https://sync.local/internal/sync/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), env)
  const check = (id: string, accept = 'application/json') => sync.fetch(new Request(`https://sync.local/internal/check/${id}`, {
    headers: { accept },
  }), env)
  const tokenA = 'source-secret-TEST'
  const tokenB = 'target-secret-TEST'
  const title = '<script>alert("sync")</script> & 日历'
  const source = [collection(101, 2, 9, 2, title), ...[102, 103, 104, 105, 106].map(id => collection(id))]
  const target = [collection(101, 3, 6, 0, title), collection(102), collection(107)]
  const requestBody = { tokenA, tokenB, from: 'source', to: 'target', mode: 'full' }
  const calls: Array<{ path: string; method: string; token: string | null; body?: unknown }> = []
  let failure: 'none' | 'identity' | 'collections' | 'write' = 'none'
  const leaked = `${tokenA} ${tokenB} Bearer bearer-leak access_token=query-leak&refresh_token=refresh-leak&client_secret=client-leak&cron_secret=cron-leak <img src=x>`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, 'https://api.bgm.tv')
    const token = request.headers.get('authorization')
    assert.ok(token === `Bearer ${tokenA}` || token === `Bearer ${tokenB}`)
    const call = { path: url.pathname, method: request.method, token, body: request.body ? await request.json() : undefined }
    calls.push(call)
    const isSource = token === `Bearer ${tokenA}`
    const upstreamError = () => Response.json({ title: 'Request rejected', description: leaked }, { status: 400 })
    if (url.pathname === '/v0/me' && request.method === 'GET') {
      if (failure === 'identity' && isSource) return Response.json({ title: 'Unauthorized', description: leaked }, { status: 401 })
      const username = isSource ? 'source' : 'target'
      return Response.json({
        id: isSource ? 1 : 2, username, nickname: username, user_group: 10, sign: '',
        avatar: { large: '', medium: '', small: '' }, email: `${username}@example.invalid`, reg_time: '2020-01-01T00:00:00Z',
      })
    }
    if (url.pathname === `/v0/users/${isSource ? 'source' : 'target'}/collections` && request.method === 'GET') {
      assert.equal(url.search, '?subject_type=2&limit=50&offset=0')
      if (failure === 'collections' && isSource) return upstreamError()
      const data = isSource ? source : target
      return Response.json({ total: data.length, limit: 50, offset: 0, data })
    }
    const matched = /^\/v0\/users\/-\/collections\/(\d+)(\/episodes)?$/.exec(url.pathname)
    assert.ok(matched, `Unexpected upstream route: ${url.pathname}`)
    const subjectId = Number(matched[1])
    assert.ok(source.some(entry => entry.subject_id === subjectId))
    if (request.method === 'GET' && matched[2]) {
      assert.equal(url.search, '?limit=1000&offset=0')
      return Response.json({ total: 2, limit: 1000, offset: 0, data: [1, 2].map(sort => ({
        episode: { id: subjectId * 10 + sort, type: 0, name: `Episode ${sort}`, name_cn: '', sort, airdate: '', comment: 0, duration: '', desc: '', disc: 0 },
        type: isSource ? 2 : sort === 1 ? 1 : 3, updated_at: 0,
      })) })
    }
    assert.equal(token, `Bearer ${tokenB}`)
    assert.equal(JSON.parse(String(db.prepare('SELECT value_json FROM airingcal_operations ORDER BY rowid DESC LIMIT 1').get()!.value_json)).status, 'running')
    if (request.method === 'POST' && !matched[2]) {
      if (failure === 'write') return upstreamError()
      return new Response(null, { status: 204 })
    }
    assert.equal(request.method, 'PATCH')
    assert.equal(matched[2], '/episodes')
    return new Response(null, { status: 204 })
  }

  try {
    const selectedIds = ['101', '102', '103', '104', '105']
    for (const selection of [
      {}, { subject_ids: [] }, { subject_ids: [...selectedIds, '106'] },
      { subject_ids: ['101', '101'] }, { subject_ids: ['101/episodes'] }, { subject_ids: ['9007199254740992'] },
      { items: [] }, { items: [{}] }, { items: Array.from({ length: 6 }, () => ({})) },
    ]) {
      const response = await post('apply', { ...requestBody, ...selection })
      assert.equal(response.status, 400, JSON.stringify(selection))
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.equal(response.headers.get('x-sync-operation-id'), null)
      assert.equal(calls.length, 0)
      assert.equal(rowCount(), 0)
    }

    const compared = await post('compare', { tokenA, tokenB })
    assert.equal(compared.status, 200)
    assert.equal(compared.headers.get('cache-control'), 'no-store')
    const comparison = await compared.json() as CompareResult
    assert.deepEqual([comparison.userA.name, comparison.userA.total, comparison.userB.name, comparison.userB.total, comparison.common], ['source', 6, 'target', 3, 2])
    assert.deepEqual(comparison.differences.map(entry => entry.externalId), ['101'])
    assert.deepEqual(comparison.same.map(entry => entry.externalId), ['102'])
    assert.deepEqual(comparison.onlyA.map(entry => entry.externalId), ['103', '104', '105', '106'])
    assert.deepEqual(comparison.onlyB.map(entry => entry.externalId), ['107'])
    assert.equal(rowCount(), 0)
    const item = comparison.differences[0]!.itemA!
    assert.deepEqual(item, { externalId: '101', title, status: 'completed', progress: 2, totalEpisodes: 2, score: 9, platform: 'bgm' })

    const beforeApply = calls.length
    const applied = await post('apply', {
      ...requestBody, mode: 'partial', items: [item], baseline: [{ externalId: '101', status: 'watching', score: 6, progress: 0, totalEpisodes: 2 }],
    })
    assert.equal(applied.status, 200)
    assert.equal(applied.headers.get('cache-control'), 'no-store')
    const operationId = applied.headers.get('x-sync-operation-id')!
    assert.match(operationId, /^[0-9a-z]+-[0-9a-f]{16}$/i)
    assert.equal(applied.headers.get('x-sync-operation-url'), `/api/check/${operationId}`)
    const results = await applied.json() as SyncResult[]
    assert.deepEqual(results, [{
      externalId: '101', title, status: 'ok', collectionStatus: { before: '在看', after: '看过' },
      scoreChange: { before: 6, after: 9 }, episodeChanged: 2, episodeProgress: { before: 0, after: 2, total: 2 },
    }])
    assert.deepEqual(calls.slice(beforeApply).filter(call => call.method !== 'GET'), [
      { path: '/v0/users/-/collections/101', method: 'POST', token: `Bearer ${tokenB}`, body: { type: 2, rate: 9 } },
      { path: '/v0/users/-/collections/101/episodes', method: 'PATCH', token: `Bearer ${tokenB}`, body: { episode_id: [1011, 1012], type: 2 } },
    ])
    assert.equal(calls.slice(beforeApply).some(call => call.path === '/v0/me' || call.path.endsWith('/collections')), false)
    const logged = await check(operationId)
    assert.equal(logged.status, 200)
    assert.equal(logged.headers.get('cache-control'), 'no-store')
    const { operation } = await logged.json() as { operation: Record<string, unknown> }
    assert.equal(operation.id, operationId)
    assert.equal(operation.status, 'ok')
    assert.deepEqual([operation.requested_count, operation.returned_count, operation.ok, operation.errors], [1, 1, 1, 0])
    assert.deepEqual(operation.items, results)
    const persisted = db.prepare('SELECT value_json, expires_at FROM airingcal_operations WHERE id = ?').get(`sync:operation:${operationId}`)!
    assert.deepEqual(JSON.parse(String(persisted.value_json)), operation)
    assert.ok(Number(persisted.expires_at) - Math.floor(Date.now() / 1000) >= 86395)
    assert.ok(Number(persisted.expires_at) - Math.floor(Date.now() / 1000) <= 86400)
    const htmlResponse = await check(operationId, 'text/html')
    assert.equal(htmlResponse.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    assert.equal(htmlResponse.headers.get('x-content-type-options'), 'nosniff')
    const html = await htmlResponse.text()
    assert.match(html, /&lt;script&gt;alert/)
    assert.match(html, /&lt;\/script&gt; &amp; 日历/)
    assert.doesNotMatch(html, /<script>/)
    assert.equal((await check('invalid-id')).status, 400)
    assert.equal((await check('missing-0123456789abcdef')).status, 404)
    db.prepare('UPDATE airingcal_operations SET expires_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), `sync:operation:${operationId}`)
    assert.equal((await check(operationId)).status, 404)

    const beforeFull = calls.length
    const full = await post('apply', { ...requestBody, subject_ids: selectedIds })
    assert.equal(full.status, 200)
    assert.deepEqual((await full.json() as SyncResult[]).map(entry => [entry.externalId, entry.status]), selectedIds.map(id => [id, 'ok']))
    assert.deepEqual(calls.slice(beforeFull).filter(call => call.method === 'POST').map(call => call.path), selectedIds.map(id => `/v0/users/-/collections/${id}`))
    assert.equal(calls.slice(beforeFull).some(call => call.path.includes('/106')), false)
    assert.equal(rowCount(), 1, 'new apply deletes expired operation rows')
    assert.equal(db.prepare('SELECT id FROM airingcal_operations WHERE id = ?').get(`sync:operation:${operationId}`), undefined)

    failure = 'write'
    const rejectedWrite = await post('apply', { ...requestBody, items: [item] })
    assert.equal(rejectedWrite.status, 200)
    const failedResults = await rejectedWrite.json() as SyncResult[]
    assert.equal(failedResults[0]!.status, 'error')
    assert.match(failedResults[0]!.error!, /Bearer \[redacted\]/)
    assert.match(failedResults[0]!.error!, /access_token=\[redacted\]/)
    const failedCheck = await check(rejectedWrite.headers.get('x-sync-operation-id')!)
    const failedLog = await failedCheck.text()
    assert.equal(JSON.parse(failedLog).operation.status, 'error')
    for (const output of [JSON.stringify(failedResults), failedLog, ...db.prepare('SELECT value_json FROM airingcal_operations').all().map(row => String(row.value_json))]) {
      for (const secret of [tokenA, tokenB, 'bearer-leak', 'query-leak', 'refresh-leak', 'client-leak', 'cron-leak']) assert.equal(output.includes(secret), false, secret)
    }
    const countBeforeCompareErrors = rowCount()
    failure = 'identity'
    const beforeIdentity = calls.length
    const rejectedIdentity = await post('compare', { tokenA, tokenB })
    assert.equal(rejectedIdentity.status, 401)
    assert.deepEqual(await rejectedIdentity.json(), { ok: false, error: { code: 'AUTHENTICATION_FAILED', message: 'Authentication failed' } })
    assert.ok(calls.slice(beforeIdentity).every(call => call.path === '/v0/me'))
    failure = 'collections'
    const rejectedCollections = await post('compare', { tokenA, tokenB })
    assert.equal(rejectedCollections.status, 200)
    const partialComparison = await rejectedCollections.json() as CompareResult
    assert.equal(partialComparison.userA.error, 'Upstream collection request failed')
    assert.equal(partialComparison.userB.total, 3)
    assert.equal(rowCount(), countBeforeCompareErrors)
    assert.equal('scheduled' in sync, false)
    assert.equal('queue' in sync, false)
  } finally {
    globalThis.fetch = originalFetch
    db.close()
  }
})
