import assert from 'node:assert/strict'
import test from 'node:test'
import { createCloudflareD1Client } from './cloudflare-d1.ts'
import { readNodeJobsConfig } from './env.ts'
import { JobError } from './errors.ts'
import { acquireJobLease } from './job-lease.ts'
import { createRunContext } from './run-context.ts'

const config = {
  cloudflareAccountId: 'a'.repeat(32),
  d1DatabaseId: '12345678-1234-4123-8123-123456789abc',
  cloudflareApiToken: 'token',
  r2Bucket: 'airing-cal-data',
  r2AccessKeyId: 'key',
  r2SecretAccessKey: 'secret',
}

test('readNodeJobsConfig accepts AIRING_CAL_* names', () => {
  const parsed = readNodeJobsConfig({
    CLOUDFLARE_ACCOUNT_ID: config.cloudflareAccountId,
    AIRING_CAL_D1_DATABASE_ID: config.d1DatabaseId,
    CLOUDFLARE_API_TOKEN: config.cloudflareApiToken,
    AIRING_CAL_R2_BUCKET: config.r2Bucket,
    R2_ACCESS_KEY_ID: config.r2AccessKeyId,
    R2_SECRET_ACCESS_KEY: config.r2SecretAccessKey,
  })
  assert.equal(parsed.d1DatabaseId, config.d1DatabaseId)
})

test('readNodeJobsConfig rejects malformed account id', () => {
  assert.throws(
    () => readNodeJobsConfig({ ...process.env, CLOUDFLARE_ACCOUNT_ID: 'short' }),
    (error: unknown) => error instanceof JobError && error.code === 'CONFIG_INVALID',
  )
})

test('createCloudflareD1Client parses query results', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: true,
    result: [{ success: true, results: [{ owner: 'run-1' }] }],
  }), { status: 200 })
  try {
    const run = createRunContext({ runId: 'run-1', deadlineAt: Date.now() + 60_000 })
    const db = createCloudflareD1Client(config, run)
    const rows = await db.query('SELECT 1')
    assert.deepEqual(rows, [{ owner: 'run-1' }])
  } finally {
    globalThis.fetch = original
  }
})

test('acquireJobLease returns null when another owner holds the lease', async () => {
  const db = {
    queries: [] as Array<{ sql: string; params: unknown[] }>,
    async query(sql: string, params: unknown[] = []) {
      this.queries.push({ sql, params })
      if (sql.includes('INSERT INTO airingcal_job_leases')) return [{ owner: 'other-run' }]
      return []
    },
    export: async () => ({}),
  }
  const run = createRunContext({ runId: 'run-1', deadlineAt: Date.now() + 60_000 })
  const lease = await acquireJobLease(db, run, 'airingcal-data-plane', 900)
  assert.equal(lease, null)
})

test('acquireJobLease guard fails when lease row disappears', async () => {
  const db = {
    async query(sql: string) {
      if (sql.includes('INSERT INTO airingcal_job_leases')) return [{ owner: 'run-1' }]
      return []
    },
    export: async () => ({}),
  }
  const run = createRunContext({ runId: 'run-1', deadlineAt: Date.now() + 60_000 })
  const lease = await acquireJobLease(db, run, 'airingcal-data-plane', 900)
  assert.ok(lease)
  await assert.rejects(() => lease!.guard(), (error: unknown) => error instanceof JobError && error.code === 'LEASE_LOST')
})
