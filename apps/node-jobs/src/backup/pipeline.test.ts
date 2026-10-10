import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import { createRunContext } from '../adapters/run-context.ts'
import { runBackupPipeline } from './pipeline.ts'

const SQL = 'PRAGMA foreign_keys=OFF;\nCREATE TABLE t (id INTEGER);\n'

class MemoryR2 implements R2Store {
  objects = new Map<string, Uint8Array>()

  async put(): Promise<void> {}

  async get(key: string, maximumBytes = 256 * 1024 * 1024): Promise<Uint8Array | null> {
    const value = this.objects.get(key)
    if (!value || value.byteLength > maximumBytes) return null
    return value
  }

  async verifiedPut(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes)
    const copy = await this.get(key, bytes.byteLength)
    if (!copy || copy.byteLength !== bytes.byteLength) throw new Error('readback failed')
  }

  close(): void {}
}

class MemoryD1 implements CloudflareD1Client {
  leaseOwner: string | null = null

  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
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

  async export(): Promise<unknown> {
    return { status: 'complete', result: { signed_url: 'https://export.test/backup.sql' } }
  }
}

test('runBackupPipeline uploads SQL export to backups/d1/', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(SQL, { status: 200 })
  const stateDir = await mkdtemp(join(tmpdir(), 'airingcal-backup-test-'))
  try {
    const store = new MemoryR2()
    const db = new MemoryD1()
    const run = createRunContext({ runId: 'run-backup', deadlineAt: Date.now() + 60_000 })
    const result = await runBackupPipeline({
      run,
      db,
      store,
      leaseName: 'airingcal-data-plane',
      leaseSeconds: 900,
      stateDir,
      now: () => 1_700_000_000_000,
      wait: async () => {},
    })
    assert.equal(result.status, 'ok')
    assert.ok([...store.objects.keys()].some((key) => key.startsWith('backups/d1/')))
  } finally {
    globalThis.fetch = original
    await rm(stateDir, { recursive: true, force: true })
  }
})
