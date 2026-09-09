import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresAuthority } from './repositories.ts'

test('publication port routes live and shadow state through distinct persisted modes', async () => {
  const queries: { sql: string; values: unknown[] }[] = []
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values })
    return { rows: [{ verified_generation: 0, verified_content_hash: null, verified_object_key: null,
      verified_at: null, verified_run_id: null, pending_generation: null, pending_content_hash: null,
      pending_object_key: null, pending_run_id: null, pending_claimed_at: null, pending_created_at: null }], rowCount: 1 }
  } } as never
  const authority = new PostgresAuthority(pool, { forbiddenValues: ['runtime-secret'] })
  await authority.publicationPort().forMode('shadow').getState()
  await authority.publicationPort().forMode('live').getState()
  await authority.publicationPort().forMode('shadow').clearUnclaimedPending({ verifiedGeneration: 0, verifiedContentHash: null })
  assert.deepEqual(queries.map(({ values }) => values), [['shadow'], ['live'], [0, null, 'shadow']])
  assert.ok(queries.slice(0, 2).every(({ sql }) => sql.includes('mode = $1')))
  assert.ok(queries[2]?.sql.includes('WHERE mode = $3'))
})
