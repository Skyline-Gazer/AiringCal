import assert from 'node:assert/strict'
import test from 'node:test'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import { createRunContext } from '../adapters/run-context.ts'
import { runBackupPipeline } from '../backup/pipeline.ts'

class SharedMemoryD1 implements CloudflareD1Client {
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

  export(): Promise<unknown> {
    return Promise.resolve({})
  }
}

class EmptyR2 implements R2Store {
  async put(): Promise<void> {}
  async get(): Promise<null> {
    return null
  }
  async verifiedPut(): Promise<void> {}
  close(): void {}
}

test('backup skips when another owner holds lease (integration)', async () => {
  const db = new SharedMemoryD1()
  db.leaseOwner = 'sync-run'
  const store = new EmptyR2()
  const backupRun = createRunContext({ runId: 'backup-run', deadlineAt: Date.now() + 60_000 })
  const backup = await runBackupPipeline({
    run: backupRun,
    db,
    store,
    leaseName: 'airingcal-data-plane',
    leaseSeconds: 900,
    stateDir: '/tmp',
    now: () => Date.now(),
    wait: () => Promise.resolve(),
  })
  assert.equal(backup.status, 'skipped')
  assert.equal(backup.stage, 'lease_busy')
})
