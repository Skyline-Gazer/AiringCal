import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import type { RunDependencies, RunResult } from './contracts.ts'
import { runFromEnvironment } from './runtime.ts'
import type { S3Port, S3PortOptions } from './publication/s3.ts'

const environment = {
  DATABASE_URL: 'postgres://database-secret@example.test/app',
  R2_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  R2_BUCKET: 'airing-cal',
  R2_ACCESS_KEY_ID: 'r2-access-secret',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
  R2_REGION: 'auto',
}

const result: RunResult = {
  id: 'run', source: 'manual', mode: 'shadow', stage: 'finished', status: 'success',
  heartbeatAt: '2026-09-09T00:00:00.000Z', finishedAt: '2026-09-09T00:00:00.000Z',
  counts: {}, stageDurations: {}, sanitizedError: null,
  components: { collection: 'success', calendar: 'success', media: 'success', publication: 'success', backup: 'success', notification: 'success' },
}

function input(): Omit<RunDependencies, 'authority' | 'lock' | 'publish' | 'backup' | 'close'> & { request: { mode: 'shadow'; source: 'manual' }; publicationCandidate: () => Promise<never> } {
  return {
    request: { mode: 'shadow', source: 'manual' }, runId: 'run', gitSha: 'a'.repeat(40), projectionUsers: [], now: () => 0,
    fetchComplete: async () => { throw new Error('not called') }, media: async () => ({ selected: 0, succeeded: 0, failed: 0 }),
    notify: async () => undefined, publicationCandidate: async () => { throw new Error('not called') },
  }
}

test('requires every documented PostgreSQL and R2 setting without echoing values', async () => {
  await assert.rejects(
    () => runFromEnvironment(input(), { ...environment, R2_BUCKET: '' }),
    (error: Error) => error.message === 'RUNTIME_CONFIG_REQUIRED:R2_BUCKET' && !error.message.includes('secret'),
  )
})

test('constructs PostgreSQL and S3 ports then injects them into runOnce', async () => {
  let databaseUrl: string | undefined
  let s3Options: S3PortOptions | undefined
  let dependencies: RunDependencies | undefined
  const s3: S3Port = { put: async () => undefined, get: async () => null, list: async () => [], delete: async () => undefined }
  const pool = { end: async () => undefined } as Pool

  assert.equal(await runFromEnvironment(input(), environment, {
    createPool: (url) => { databaseUrl = url; return pool },
    createS3Port: (options) => { s3Options = options; return s3 },
    runOnce: async (deps) => { dependencies = deps; return result },
  }), result)
  assert.equal(databaseUrl, environment.DATABASE_URL)
  assert.deepEqual(s3Options, {
    bucket: environment.R2_BUCKET, endpoint: environment.R2_ENDPOINT, region: environment.R2_REGION,
    accessKeyId: environment.R2_ACCESS_KEY_ID, secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
  })
  assert.ok(dependencies?.authority)
  assert.ok(dependencies?.lock)
  assert.equal(typeof dependencies?.backup, 'function')
  assert.equal(dependencies?.close, pool.end)
})

test('turns a replayable publication pending outcome into the existing coordinator failure path', async () => {
  let dependencies: RunDependencies | undefined
  const publicationRow = {
    verified_generation: 0, verified_content_hash: null, verified_object_key: null, verified_at: null, verified_run_id: null,
    pending_generation: null, pending_content_hash: null, pending_object_key: null, pending_run_id: null, pending_claimed_at: null, pending_created_at: null,
  }
  const client = { query: async () => ({ rows: [publicationRow], rowCount: 1 }), release: () => undefined }
  const pool = { query: client.query, connect: async () => client, end: async () => undefined } as unknown as Pool
  const s3: S3Port = { put: async () => { throw new Error('r2-secret') }, get: async () => null, list: async () => [], delete: async () => undefined }
  const candidate = { snapshot: { collections: [], calendar: [], published_at: 1 }, runId: 'run', observedAt: '2026-09-09T00:00:00.000Z', gitSha: 'a'.repeat(40) }

  await runFromEnvironment({ ...input(), publicationCandidate: async () => candidate }, environment, {
    createPool: () => pool, createS3Port: () => s3, runOnce: async (deps) => { dependencies = deps; return result },
  })
  await assert.rejects(() => dependencies!.publish({ runId: 'run', observedAt: candidate.observedAt, mode: 'shadow', source: 'manual' }),
    (error: Error) => error.message === 'PUBLICATION_PENDING' && !error.message.includes('r2-secret'))
})
