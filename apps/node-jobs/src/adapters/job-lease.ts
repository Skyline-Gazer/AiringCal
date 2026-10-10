import type { CloudflareD1Client } from './cloudflare-d1.ts'
import { fail, isJobError } from './errors.ts'
import type { RunContext } from './run-context.ts'

export interface JobLease {
  guard(): Promise<void>
  release(): Promise<void>
}

const RECOVERABLE_D1 = new Set(['REQUEST_FAILED', 'D1_RESPONSE_INVALID', 'UPSTREAM_UNAVAILABLE', 'D1_REQUEST_FAILED'])

export async function acquireJobLease(
  db: CloudflareD1Client,
  run: RunContext,
  name: string,
  durationSeconds: number,
): Promise<JobLease | null> {
  let rows: Array<{ owner?: string }>
  try {
    rows = await db.query(
      `INSERT INTO airingcal_job_leases (name, owner, expires_at) VALUES (?, ?, unixepoch() + ?)
       ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
       WHERE airingcal_job_leases.expires_at <= unixepoch() OR airingcal_job_leases.owner=excluded.owner
       RETURNING owner`,
      [name, run.owner, durationSeconds],
    )
  } catch (error) {
    if (isJobError(error) && (RECOVERABLE_D1.has(error.code) || (error.code === 'D1_REQUEST_FAILED' && (error.httpStatus ?? 0) >= 500))) {
      try {
        await db.query('DELETE FROM airingcal_job_leases WHERE name=? AND owner=?', [name, run.owner])
        console.warn(JSON.stringify({ status: 'recovered', stage: 'lease_recovery', released_if_owned: true }))
      } catch (recoveryError) {
        console.error(JSON.stringify({
          status: 'warning',
          stage: 'lease_recovery',
          lease_may_remain: true,
          retry_after_seconds: durationSeconds,
          message: recoveryError instanceof Error ? recoveryError.message : 'unknown',
        }))
      }
    }
    throw error
  }
  if (rows.length !== 1 || rows[0].owner !== run.owner) return null
  return {
    async guard() {
      run.guard(30_000)
      const current = await db.query(
        'SELECT owner FROM airingcal_job_leases WHERE name=? AND owner=? AND expires_at > unixepoch() + 30',
        [name, run.owner],
      )
      if (current.length !== 1) fail('LEASE_LOST')
    },
    release: () => db.query('DELETE FROM airingcal_job_leases WHERE name=? AND owner=?', [name, run.owner]).then(() => undefined),
  }
}
