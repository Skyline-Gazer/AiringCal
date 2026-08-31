import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { PostgresAuthority } from './repositories.ts'

function fixture() {
  const calls: { sql: string; values: unknown[] }[] = []
  let releases = 0
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    },
    release: () => { releases++ },
  }
  const authority = new PostgresAuthority({ connect: async () => client, query: client.query } as unknown as Pool, { forbiddenValues: ['token-secret'] })
  return { authority, calls, client, releases: () => releases }
}
test('heartbeat writes only sanitized stage and timestamp for a running run', async () => {
  const { authority, calls } = fixture()
  await authority.heartbeat('run', 'media', '2026-08-31T00:00:00Z')
  assert.match(calls[0]!.sql, /status = 'running'/)
  await assert.rejects(() => authority.heartbeat('run', 'token-secret', '2026-08-31T00:00:00Z'))
  assert.equal(calls.length, 1)
})
test('subject session holds advisory lock around read, external work and save, then releases', async () => {
  const { authority, calls, releases } = fixture()
  await authority.withSubject(42, async ({ current }) => {
    assert.equal(current, null)
    assert.equal(releases(), 0)
    assert.ok(calls.some(({ sql }) => sql.includes('FROM subject_media')))
    assert.ok(!calls.some(({ sql }) => sql.includes('pg_advisory_unlock')))
  })
  assert.match(calls.at(-1)!.sql, /pg_advisory_unlock/)
  assert.equal(releases(), 1)
})
test('subject failure unlocks/releases and escaped save cannot mutate outside the lock', async () => {
  const { authority, releases } = fixture()
  let save: ((input: never) => Promise<boolean>) | undefined
  await assert.rejects(() => authority.withSubject(42, async (session) => { save = session.save; throw new Error('failed') }))
  assert.equal(releases(), 1)
  await assert.rejects(() => save!({} as never), /SUBJECT_SESSION_CLOSED/)
})

test('business lock uses a dedicated session and releases it on lock miss and explicit cleanup', async () => {
  const { authority, calls, releases } = fixture()
  const lock = authority.businessLock()
  assert.equal(await lock.acquire(), true)
  assert.equal(releases(), 0)
  assert.ok(BigInt(String(calls[0]!.values[0])) < 0n)
  await lock.release()
  assert.equal(releases(), 1)
  await lock.release()
  assert.equal(releases(), 1)
})

test('candidate adapter exposes deterministic priority from authoritative state', async () => {
  const { authority, calls } = fixture()
  assert.deepEqual(await authority.mediaCandidates({ now: '2026-08-31T00:00:00Z', limit: 200 }), [])
  assert.match(calls[0]!.sql, /new_or_changed/)
  assert.match(calls[0]!.sql, /next_retry_at/)
})
