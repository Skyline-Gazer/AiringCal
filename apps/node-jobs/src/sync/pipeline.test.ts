import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { createRunContext } from '../adapters/run-context.ts'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import { noopMediaRefresh } from './media-port.ts'
import { runSyncPipeline } from './pipeline.ts'

class MemoryR2 implements R2Store {
  objects = new Map<string, Uint8Array>()

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body)
  }

  async get(key: string, maximumBytes = 32 * 1024 * 1024): Promise<Uint8Array | null> {
    const value = this.objects.get(key)
    if (!value || value.byteLength > maximumBytes) return null
    return value
  }

  async verifiedPut(key: string, bytes: Uint8Array, contentType?: string): Promise<void> {
    await this.put(key, bytes)
    const copy = await this.get(key, bytes.byteLength)
    if (!copy || copy.byteLength !== bytes.byteLength) throw new Error('readback failed')
  }

  close(): void {}
}

class MemoryD1 implements CloudflareD1Client {
  leaseOwner: string | null = null
  queries: string[] = []

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    this.queries.push(sql)
    if (sql.includes('INSERT INTO airingcal_job_leases')) {
      if (this.leaseOwner && this.leaseOwner !== params[1]) return []
      this.leaseOwner = String(params[1])
      return [{ owner: this.leaseOwner }]
    }
    if (sql.includes('SELECT owner FROM airingcal_job_leases')) {
      return this.leaseOwner === params[1] ? [{ owner: this.leaseOwner }] : []
    }
    if (sql.includes('DELETE FROM airingcal_job_leases')) {
      if (this.leaseOwner === params[1]) this.leaseOwner = null
      return []
    }
    return []
  }

  export(): Promise<unknown> {
    return Promise.resolve({})
  }
}

const gitSha = 'a'.repeat(40)

test('runSyncPipeline publishes first snapshot when R2 is empty', async () => {
  const store = new MemoryR2()
  const db = new MemoryD1()
  const run = createRunContext({ runId: 'run-test', deadlineAt: Date.now() + 60_000 })
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )

  const result = await runSyncPipeline({
    run,
    db,
    store,
    syncConfig: { users: [{ userId: '1', username: 'u' }], primaryUserId: '1', gitSha },
    leaseName: 'airingcal-data-plane',
    leaseSeconds: 900,
    fetchInput: async () => input,
    media: noopMediaRefresh,
    now: () => 1_700_000_000_000,
  })

  assert.equal(result.status, 'ok')
  assert.ok(store.objects.has('public/manifest.json'))
  assert.equal(result.generation, 1)
})

test('runSyncPipeline skips when lease is busy', async () => {
  const db = new MemoryD1()
  db.leaseOwner = 'other'
  const result = await runSyncPipeline({
    run: createRunContext({ runId: 'run-2', deadlineAt: Date.now() + 60_000 }),
    db,
    store: new MemoryR2(),
    syncConfig: { users: [{ userId: '1', username: 'u' }], primaryUserId: '1', gitSha },
    leaseName: 'airingcal-data-plane',
    leaseSeconds: 900,
    fetchInput: async () => { throw new Error('should not fetch') },
    media: noopMediaRefresh,
    now: () => Date.now(),
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.stage, 'lease_busy')
})
