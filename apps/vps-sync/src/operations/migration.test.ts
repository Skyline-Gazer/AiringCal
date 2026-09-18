import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildManifest,
  buildPublicSnapshot,
  canonicalSnapshotBytes,
} from '@airing-cal/domain'
import { canonicalJson } from '@airing-cal/storage'

type MigrationApi = typeof import('./migration.js')

async function migrationApi(): Promise<MigrationApi> {
  try {
    return await import('./migration.js')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('guarded migration operations are not implemented')
    }
    throw error
  }
}

const gitSha = 'a'.repeat(40)

async function manifestFixture() {
  const snapshot = await buildPublicSnapshot({
    collections: [],
    calendar: [],
    published_at: 1_789_444_800,
  }, 1)
  const manifest = buildManifest(snapshot, {
    source_observed_at: snapshot.published_at,
    git_sha: gitSha,
  })
  return {
    snapshot,
    snapshotBytes: canonicalSnapshotBytes(snapshot),
    manifest,
    manifestBytes: new TextEncoder().encode(canonicalJson(manifest)),
  }
}

function fakeStorage() {
  const writes: { key: string; bytes: Uint8Array }[] = []
  const objects = new Map<string, Uint8Array>()
  return {
    writes,
    objects,
    port: {
      get: async (key: string) => objects.get(key) ?? null,
      put: async (key: string, bytes: Uint8Array) => {
        writes.push({ key, bytes })
        objects.set(key, bytes)
      },
    },
  }
}

test('writes shadow snapshots and manifests only inside the shadow namespace', async () => {
  const { shadowCompare } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()

  const result = await shadowCompare(storage.port, {
    snapshotKey: fixture.manifest.snapshot_key,
    snapshotBytes: fixture.snapshotBytes,
    manifestBytes: fixture.manifestBytes,
    live: { collections: [{ subject_id: 1, name: 'old' }] },
    shadow: { collections: [{ subject_id: 1, name: 'new' }] },
  })

  assert.deepEqual(storage.writes.map(({ key }) => key), [
    `shadow/${fixture.manifest.snapshot_key}`,
    'shadow/manifest.json',
  ])
  assert.ok(result.writes.every((key) => key.startsWith('shadow/')))
  assert.equal(result.equal, false)
  assert.deepEqual(result.differences, [{
    path: '/collections/0/name',
    expected: 'old',
    actual: 'new',
  }])
})

test('compares nested values with deterministic field-level paths', async () => {
  const { compareFields } = await migrationApi()
  assert.deepEqual(compareFields({
    a: { same: 1, changed: true },
    list: [{ id: 1 }],
  }, {
    a: { same: 1, changed: false, extra: 'shadow' },
    list: [],
  }), [
    { path: '/a/changed', expected: true, actual: false },
    { path: '/a/extra', expected: undefined, actual: 'shadow' },
    { path: '/list/0', expected: { id: 1 }, actual: undefined },
  ])
})

test('dry-run shadow and restore operations produce evidence without touching ports', async () => {
  const { restoreVerifyOperation, shadowCompare } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()
  let targetRead = false

  const shadow = await shadowCompare(storage.port, {
    snapshotKey: fixture.manifest.snapshot_key,
    snapshotBytes: fixture.snapshotBytes,
    manifestBytes: fixture.manifestBytes,
    live: {},
    shadow: {},
    dryRun: true,
  })
  assert.deepEqual(shadow.writes, [])
  assert.equal(shadow.status, 'dry_run')

  const restore = await restoreVerifyOperation({} as never, {
    backupKey: 'backups/postgres/2026/09/18/20260918T030405006Z-' + gitSha + '.dump',
    targetUrl: () => {
      targetRead = true
      return 'postgresql://restore.example.test/bangumi'
    },
    dryRun: true,
  })
  assert.equal(targetRead, false)
  assert.equal(restore.status, 'dry_run')
})

test('supports three fake shadow rounds without ever producing a live write', async () => {
  const { shadowCompare } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()

  for (let round = 0; round < 3; round += 1) {
    const result = await shadowCompare(storage.port, {
      snapshotKey: fixture.manifest.snapshot_key,
      snapshotBytes: fixture.snapshotBytes,
      manifestBytes: fixture.manifestBytes,
      live: { round, value: 'same' },
      shadow: { round, value: 'same' },
    })
    assert.equal(result.equal, true)
  }
  assert.equal(storage.writes.length, 6)
  assert.ok(storage.writes.every(({ key }) => key.startsWith('shadow/')))
})

test('cutover promotes the shadow snapshot before publishing a live manifest', async () => {
  const { cutover, readVerifiedManifest } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()
  await storage.port.put('shadow/manifest.json', fixture.manifestBytes)
  await storage.port.put(`shadow/${fixture.manifest.snapshot_key}`, fixture.snapshotBytes)
  storage.writes.length = 0
  const verified = await readVerifiedManifest(storage.port, 'shadow/manifest.json')

  await assert.rejects(
    () => cutover(storage.port, { verifiedShadow: verified, approvalToken: '' }),
    /CUTOVER_APPROVAL_REQUIRED/,
  )
  assert.deepEqual(storage.writes, [])

  const result = await cutover(storage.port, { verifiedShadow: verified, approvalToken: 'approved' })
  assert.equal(result.status, 'executed')
  assert.deepEqual(storage.writes.map(({ key }) => key), [
    fixture.manifest.snapshot_key,
    'public/manifest.json',
  ])
  const live = await readVerifiedManifest(storage.port, 'public/manifest.json')
  assert.deepEqual(live.snapshotBytes, fixture.snapshotBytes)
  assert.deepEqual(live.manifest, fixture.manifest)
})

test('cutover does not publish a live manifest when live snapshot promotion readback fails', async () => {
  const { cutover, readVerifiedManifest } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()
  await storage.port.put('shadow/manifest.json', fixture.manifestBytes)
  await storage.port.put(`shadow/${fixture.manifest.snapshot_key}`, fixture.snapshotBytes)
  storage.writes.length = 0
  const verified = await readVerifiedManifest(storage.port, 'shadow/manifest.json')
  const failingStorage = {
    get: storage.port.get,
    put: async (key: string, bytes: Uint8Array) => {
      if (key === fixture.manifest.snapshot_key) {
        await storage.port.put(key, new TextEncoder().encode('{'))
        return
      }
      await storage.port.put(key, bytes)
    },
  }

  await assert.rejects(
    () => cutover(failingStorage, { verifiedShadow: verified, approvalToken: 'approved' }),
    /MIGRATION_SNAPSHOT_INVALID/,
  )
  assert.deepEqual(storage.writes.map(({ key }) => key), [fixture.manifest.snapshot_key])
  await assert.rejects(
    () => readVerifiedManifest(storage.port, 'public/manifest.json'),
    /MIGRATION_MANIFEST_MISSING/,
  )
})

test('rollback refuses an unverified manifest and restores only a verified envelope', async () => {
  const { rollback, verifyManifestEnvelope } = await migrationApi()
  const fixture = await manifestFixture()
  const storage = fakeStorage()

  await assert.rejects(
    () => rollback(storage.port, {
      verifiedManifest: {
        key: 'public/manifest.json',
        bytes: fixture.manifestBytes,
        snapshotBytes: fixture.snapshotBytes,
        manifest: fixture.manifest,
        verified: false,
      },
    }),
    /ROLLBACK_MANIFEST_UNVERIFIED/,
  )
  assert.deepEqual(storage.writes, [])

  const verified = await verifyManifestEnvelope({
    key: 'public/manifest.json',
    bytes: fixture.manifestBytes,
    snapshotBytes: fixture.snapshotBytes,
  })
  const result = await rollback(storage.port, { verifiedManifest: verified })
  assert.equal(result.status, 'executed')
  assert.deepEqual(storage.writes.map(({ key }) => key), ['public/manifest.json'])
})

test('parses guarded operation commands without accepting database URLs or approval secrets in argv', async () => {
  const { main, parseMigrationRequest } = await import('../cli.js')
  assert.deepEqual(parseMigrationRequest([
    'shadow-compare', '--mode=shadow', '--dry-run',
  ]), { command: 'shadow-compare', mode: 'shadow', dryRun: true })
  assert.deepEqual(parseMigrationRequest([
    'restore-verify', '--backup-key=backups/postgres/2026/09/18/20260918T030405006Z-' + gitSha + '.dump',
    '--target-env=RESTORE_DATABASE_URL',
  ]), {
    command: 'restore-verify',
    backupKey: 'backups/postgres/2026/09/18/20260918T030405006Z-' + gitSha + '.dump',
    targetEnv: 'RESTORE_DATABASE_URL',
    dryRun: false,
  })
  assert.deepEqual(parseMigrationRequest([
    'cutover', '--mode=live', '--approval-token-env=CUTOVER_APPROVAL_TOKEN', '--dry-run',
  ]), {
    command: 'cutover', mode: 'live', approvalTokenEnv: 'CUTOVER_APPROVAL_TOKEN', dryRun: true,
  })
  assert.deepEqual(parseMigrationRequest([
    'rollback', '--mode=live', '--manifest-key=public/manifest.json', '--dry-run',
  ]), {
    command: 'rollback', mode: 'live', manifestKey: 'public/manifest.json', dryRun: true,
  })
  assert.throws(
    () => parseMigrationRequest([
      'restore-verify',
      '--backup-key=backups/postgres/2026/09/18/20260918T030405006Z-' + gitSha + '.dump',
      '--target-env=postgresql://db',
    ]),
    /MIGRATION_ENV_NAME_INVALID/,
  )
  for (const badKey of [
    'https://example.test/backup.dump',
    'postgresql://user:password@example.test/db',
    'backups//dump',
    'backups/../dump',
    'backups/secret?token=raw',
    'backups/secret#fragment',
    'backups/secret\u0000.dump',
  ]) {
    assert.throws(
      () => parseMigrationRequest(['restore-verify', `--backup-key=${badKey}`, '--target-env=RESTORE_DATABASE_URL']),
      /MIGRATION_BACKUP_KEY_INVALID/,
      badKey,
    )
    assert.throws(
      () => parseMigrationRequest(['rollback', '--mode=live', `--manifest-key=${badKey}`]),
      /MIGRATION_MANIFEST_KEY_INVALID/,
      badKey,
    )
  }
  assert.throws(
    () => parseMigrationRequest(['cutover', '--mode=live', '--approval-token=secret']),
    /MIGRATION_ARGUMENT_INVALID/,
  )
  await assert.rejects(
    () => main(undefined, undefined, ['cutover', '--mode=live', '--approval-token-env=CUTOVER_APPROVAL_TOKEN']),
    /MIGRATION_RUNTIME_REQUIRED/,
  )
})
