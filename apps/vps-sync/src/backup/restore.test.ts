import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import test from 'node:test'
import {
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  snapshotKey,
} from '@airing-cal/domain'
import type {
  PublicCalendarDayV1,
  PublicCalendarSubjectV1,
  PublicCollectionItemV1,
} from '@airing-cal/storage'
import { canonicalJson } from '@airing-cal/storage'

type RestoreSession = {
  withSessionLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>
  isEmpty(): Promise<boolean>
  migrations(): Promise<readonly { name: string; checksum: string }[]>
  rowCounts(): Promise<Record<string, number>>
  publication(): Promise<{
    generation: number
    content_hash: string
    object_key: string
    published_at: number
    observed_at: number
    run_id: string
    item_count: number
    git_sha: string
  } | null>
  snapshotProjection(): Promise<{
    collections: PublicCollectionItemV1[]
    calendar: PublicCalendarDayV1[]
  }>
  close(): Promise<void>
}

type RestoreApi = {
  restoreVerify(
    deps: Record<string, unknown>,
    key: string,
    targetUrl: () => string,
  ): Promise<Record<string, unknown>>
}

async function restoreApi(): Promise<RestoreApi> {
  try {
    return await import('./restore.js') as unknown as RestoreApi
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('restore verification flow is not implemented')
    }
    throw error
  }
}

const productionUrl = 'postgresql://prod-user:prod-password@db.example.test:5432/bangumi?sslmode=require'
const targetUrlValue = 'postgresql://restore-user:restore-password@restore.example.test:5432/bangumi?sslmode=require'
const dumpKey = 'backups/postgres/2026/09/15/20260915T030405006Z-' + 'a'.repeat(40) + '.dump'
const manifestKey = dumpKey.replace(/\.dump$/, '.json')
const dumpBytes = Buffer.from('verified custom-format PostgreSQL dump')
const gitSha = 'b'.repeat(40)
const backupGitSha = 'a'.repeat(40)
const tempRoot = '/tmp/airing-cal-restore-test'
const migrations = [
  { name: '0001_initial.sql', checksum: '33e5799c9709ff8ef843b952d6b986d9f5e1e716eb92f693df088c7f019e6b23' },
  { name: '0002_media_component_state.sql', checksum: 'b052376d8a07dbfcff7b329c1c59144b92b10fe16dddf0ad33e178b0dac0a28a' },
]
const rowCounts = {
  users: 1,
  subjects: 1,
  collection_items: 1,
  subject_media: 1,
  calendar_entries: 1,
  sync_runs: 1,
  publications: 1,
}

function collectionItem(overrides: Partial<PublicCollectionItemV1> = {}): PublicCollectionItemV1 {
  return {
    subject_id: 1,
    name: 'Database subject',
    name_cn: '数据库条目',
    summary: 'from restored database',
    images: { common: null, large: null },
    image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
    eps: 12,
    total_episodes: 12,
    ep_status: 3,
    vol_status: 0,
    type: 2,
    collection_type: 1,
    rate: 8,
    nsfw: false,
    date: '2026-09-01',
    tags: ['restore'],
    updated_at: '2026-09-15T03:00:00.000Z',
    ...overrides,
  }
}

function calendarSubject(overrides: Partial<PublicCalendarSubjectV1> = {}): PublicCalendarSubjectV1 {
  return {
    subject_id: 1,
    id: 1,
    type: 2,
    name: 'Database subject',
    name_cn: '数据库条目',
    summary: 'from restored database',
    images: { common: null, large: null },
    image_status: { common: 'pending_next_cron', large: 'pending_next_cron' },
    nsfw: false,
    date: '2026-09-01',
    eps: 12,
    total_episodes: 12,
    ...overrides,
  }
}

async function snapshotFixture() {
  const projection = {
    collections: [collectionItem()],
    calendar: [{
      weekday: { en: 'db-en', cn: 'db-cn', ja: 'db-ja', id: 1 },
      items: [calendarSubject()],
    }],
  }
  const baseline = await buildPublicSnapshot({
    collections: projection.collections,
    calendar: [{
      weekday: { en: 'Mon', cn: '星期一', ja: '月曜日', id: 1 },
      items: projection.calendar[0]!.items,
    }],
    published_at: 1_789_444_800,
  }, 7)
  const publication = {
    generation: baseline.generation,
    content_hash: baseline.content_hash,
    object_key: snapshotKey(baseline.generation, baseline.content_hash),
    published_at: baseline.published_at,
    observed_at: baseline.published_at,
    run_id: 'run-restore-1',
    item_count: baseline.summary._total,
    git_sha: gitSha,
  }
  const manifest = {
    schema_version: 1,
    run_id: 'run-backup-1',
    git_sha: backupGitSha,
    created_at: '2026-09-15T03:04:05.006Z',
    object_key: dumpKey,
    size: dumpBytes.length,
    sha256: createHash('sha256').update(dumpBytes).digest('hex'),
  }
  const objects = new Map<string, Uint8Array>([
    [dumpKey, dumpBytes],
    [manifestKey, new TextEncoder().encode(canonicalJson(manifest))],
    [publication.object_key, canonicalSnapshotBytes(baseline)],
  ])
  return { baseline, publication, projection, manifest, objects }
}

async function makeFixture(options: {
  empty?: boolean
  lockAvailable?: boolean
  publication?: Awaited<ReturnType<typeof snapshotFixture>>['publication'] | null
  projection?: Awaited<ReturnType<typeof snapshotFixture>>['projection']
  objects?: Map<string, Uint8Array>
} = {}) {
  const base = await snapshotFixture()
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  await chmod(tempRoot, 0o700)
  const objects = options.objects ?? base.objects
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
  const sessions: RestoreSession[] = []
  const firstSession: RestoreSession = {
    withSessionLock: async (work) => options.lockAvailable === false
      ? { acquired: false }
      : { acquired: true, value: await work() },
    isEmpty: async () => options.empty ?? true,
    migrations: async () => [],
    rowCounts: async () => ({}),
    publication: async () => null,
    snapshotProjection: async () => ({ collections: [], calendar: [] }),
    close: async () => {},
  }
  const restoredSession: RestoreSession = {
    withSessionLock: async (work) => ({ acquired: true, value: await work() }),
    isEmpty: async () => true,
    migrations: async () => migrations,
    rowCounts: async () => rowCounts,
    publication: async () => options.publication === undefined ? base.publication : options.publication,
    snapshotProjection: async () => options.projection ?? base.projection,
    close: async () => {},
  }
  const deps = {
    productionUrl,
    storage: {
      get: async (key: string) => objects.get(key) ?? null,
    },
    database: {
      connect: async (_url: string) => {
        const session = sessions.length === 0 ? firstSession : restoredSession
        sessions.push(session)
        return session
      },
    },
    expectedMigrations: migrations,
    tempRoot,
    runCommand: async (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      calls.push({ command, args: [...args], env: options.env })
    },
  }
  return { base, deps, calls, sessions }
}

test('rejects a non-empty target and a target with the production database identity before pg_restore', async () => {
  const { restoreVerify } = await restoreApi()
  for (const [label, targetUrl, empty] of [
    ['non-empty target', targetUrlValue, false],
    ['production identity with different credentials', 'postgresql://other-user:other-password@db.example.test:5432/bangumi', true],
  ] as const) {
    const fixture = await makeFixture({ empty })
    await assert.rejects(
      () => restoreVerify(fixture.deps, dumpKey, () => targetUrl),
      label === 'non-empty target' ? /RESTORE_TARGET_NOT_EMPTY/ : /RESTORE_TARGET_IS_PRODUCTION/,
    )
    assert.equal(fixture.calls.length, 0, `${label} must fail before pg_restore`)
  }
})

test('does not run pg_restore when the empty target session cannot acquire its lock', async () => {
  const { restoreVerify } = await restoreApi()
  const fixture = await makeFixture({ lockAvailable: false })

  await assert.rejects(
    () => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue),
    /RESTORE_TARGET_LOCK_UNAVAILABLE/,
  )
  assert.equal(fixture.calls.length, 0)
})

test('downloads and verifies a dump, restores with PG17-safe flags, then validates migrations, row counts, DB projection, ordering, labels and regenerated hash', async () => {
  const { restoreVerify } = await restoreApi()
  const fixture = await makeFixture()
  const report = await restoreVerify(fixture.deps, dumpKey, () => targetUrlValue)

  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.calls[0]?.command, 'pg_restore')
  assert.deepEqual(fixture.calls[0]?.args, [
    '--dbname=service=airing-cal-restore',
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    fixture.calls[0]?.args.at(-1),
  ])
  assert.ok(fixture.calls[0]?.args.at(-1)?.endsWith('.dump'))
  assert.ok(!fixture.calls[0]?.args.some((arg) => arg.includes(targetUrlValue)))
  assert.equal(fixture.calls[0]?.env.DATABASE_URL, undefined)
  assert.equal(report.key, dumpKey)
  assert.equal(report.size, dumpBytes.length)
  assert.equal(report.sha256, fixture.base.manifest.sha256)
  assert.deepEqual(report.migrations, migrations)
  assert.deepEqual(report.rowCounts, rowCounts)
  assert.equal(report.snapshotHash, fixture.base.baseline.content_hash)
})

test('uses baseline only for calendar labels and historical ordering, never for DB-backed values', async () => {
  const { restoreVerify } = await restoreApi()
  const fixture = await makeFixture({
    projection: {
      collections: [collectionItem({ name: 'database value' })],
      calendar: [{
        weekday: { en: 'untrusted-db-label', cn: 'untrusted-db-label', ja: 'untrusted-db-label', id: 1 },
        items: [calendarSubject({ name: 'database calendar value' })],
      }],
    },
  })
  await assert.rejects(
    () => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue),
    /RESTORE_SNAPSHOT_HASH_MISMATCH/,
  )
})

test('fails closed on manifest/checksum errors and missing or mismatched immutable baseline', async (t) => {
  const { restoreVerify } = await restoreApi()

  await t.test('dump checksum mismatch', async () => {
    const fixture = await makeFixture()
    const badManifest = { ...fixture.base.manifest, sha256: 'f'.repeat(64) }
    fixture.deps.storage.get = async (key: string) => key === manifestKey
      ? new TextEncoder().encode(canonicalJson(badManifest))
      : fixture.base.objects.get(key) ?? null
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_CHECKSUM_MISMATCH/)
    assert.equal(fixture.calls.length, 0)
  })

  await t.test('non-canonical manifest timestamp', async () => {
    const fixture = await makeFixture()
    const badManifest = { ...fixture.base.manifest, created_at: 'not-a-timestamp' }
    fixture.deps.storage.get = async (key: string) => key === manifestKey
      ? new TextEncoder().encode(canonicalJson(badManifest))
      : fixture.base.objects.get(key) ?? null
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_MANIFEST_INVALID/)
    assert.equal(fixture.calls.length, 0)
  })

  await t.test('manifest git SHA must match the dump key', async () => {
    const fixture = await makeFixture()
    const badManifest = { ...fixture.base.manifest, git_sha: gitSha }
    fixture.deps.storage.get = async (key: string) => key === manifestKey
      ? new TextEncoder().encode(canonicalJson(badManifest))
      : fixture.base.objects.get(key) ?? null
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_MANIFEST_INVALID/)
    assert.equal(fixture.calls.length, 0)
  })

  await t.test('manifest timestamp must match the dump key', async () => {
    const fixture = await makeFixture()
    const badManifest = { ...fixture.base.manifest, created_at: '2026-09-15T03:04:05.007Z' }
    fixture.deps.storage.get = async (key: string) => key === manifestKey
      ? new TextEncoder().encode(canonicalJson(badManifest))
      : fixture.base.objects.get(key) ?? null
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_MANIFEST_INVALID/)
    assert.equal(fixture.calls.length, 0)
  })

  await t.test('missing restored publication', async () => {
    const fixture = await makeFixture({ publication: null })
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_BASELINE_INVALID/)
  })

  await t.test('missing immutable baseline object', async () => {
    const fixture = await makeFixture()
    fixture.deps.storage.get = async (key: string) => key === fixture.base.publication.object_key
      ? null
      : fixture.base.objects.get(key) ?? null
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_BASELINE_INVALID/)
  })

  await t.test('baseline key/hash mismatch', async () => {
    const fixture = await makeFixture({
      publication: { ...fixturePlaceholderPublication(await snapshotFixture()), object_key: 'snapshots/v1/7-' + '0'.repeat(64) + '.json' },
    })
    await assert.rejects(() => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue), /RESTORE_BASELINE_INVALID/)
  })
})

test('fails closed when restored DB identity sets differ from baseline ordering indexes', async () => {
  const { restoreVerify } = await restoreApi()
  const fixture = await makeFixture({
    projection: {
      collections: [collectionItem(), collectionItem({ subject_id: 2 })],
      calendar: [{
        weekday: { en: 'db-en', cn: 'db-cn', ja: 'db-ja', id: 1 },
        items: [calendarSubject()],
      }],
    },
  })
  await assert.rejects(
    () => restoreVerify(fixture.deps, dumpKey, () => targetUrlValue),
    /RESTORE_SNAPSHOT_IDENTITY_MISMATCH/,
  )
})

function fixturePlaceholderPublication(fixture: Awaited<ReturnType<typeof snapshotFixture>>) {
  return fixture.publication
}
