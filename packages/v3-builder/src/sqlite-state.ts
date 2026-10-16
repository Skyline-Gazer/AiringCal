import { DatabaseSync } from 'node:sqlite'
import type { BuilderJobLease, BuilderStateStore } from '@airing-cal/v3-core'

export class SqliteBuilderStateStore implements BuilderStateStore {
  constructor(private readonly db: DatabaseSync) {}

  async acquireLease(
    jobId: string,
    ownerToken: string,
    ttlSeconds: number,
    nowUnix = Math.floor(Date.now() / 1000),
  ): Promise<boolean> {
    const expiresAt = nowUnix + ttlSeconds
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(
        'SELECT owner_token, expires_at_unix FROM builder_job_leases WHERE job_id = ?',
      ).get(jobId) as { owner_token: string; expires_at_unix: number } | undefined

      if (row && row.expires_at_unix > nowUnix && row.owner_token !== ownerToken) {
        this.db.exec('ROLLBACK')
        return false
      }

      this.db.prepare(
        `INSERT INTO builder_job_leases (job_id, owner_token, expires_at_unix, updated_at_unix)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           owner_token = excluded.owner_token,
           expires_at_unix = excluded.expires_at_unix,
           updated_at_unix = excluded.updated_at_unix`,
      ).run(jobId, ownerToken, expiresAt, nowUnix)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  async releaseLease(jobId: string, ownerToken: string): Promise<void> {
    this.db.prepare(
      'DELETE FROM builder_job_leases WHERE job_id = ? AND owner_token = ?',
    ).run(jobId, ownerToken)
  }

  async getLease(jobId: string): Promise<BuilderJobLease | null> {
    const row = this.db.prepare(
      'SELECT job_id, owner_token, expires_at_unix FROM builder_job_leases WHERE job_id = ?',
    ).get(jobId) as { job_id: string; owner_token: string; expires_at_unix: number } | undefined
    if (!row) return null
    return {
      job_id: row.job_id,
      owner_token: row.owner_token,
      expires_at_unix: row.expires_at_unix,
    }
  }

  async setKv(key: string, valueJson: string, nowUnix = Math.floor(Date.now() / 1000)): Promise<void> {
    this.db.prepare(
      `INSERT INTO builder_kv (key, value_json, updated_at_unix)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at_unix = excluded.updated_at_unix`,
    ).run(key, valueJson, nowUnix)
  }

  async getKv(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value_json FROM builder_kv WHERE key = ?').get(key) as
      | { value_json: string }
      | undefined
    return row?.value_json ?? null
  }
}
