import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildPublicSnapshot, canonicalSnapshotBytes, parsePublicSnapshotV1, snapshotKey } from '@airing-cal/domain'
import type { PublicCalendarDayV1, PublicCollectionItemV1, PublicSnapshotV1 } from '@airing-cal/storage'
import { canonicalJson } from '@airing-cal/storage'
import type { S3Port } from '../publication/s3.js'

const RESTORE_TEMP_ROOT = '/tmp/airing-cal'
const RESTORE_SERVICE_NAME = 'airing-cal-restore'
const RESTORE_SCHEMA_VERSION = 1
const REQUIRED_ROW_TABLES = [
  'users',
  'subjects',
  'collection_items',
  'subject_media',
  'calendar_entries',
  'sync_runs',
  'publications',
] as const
const LIBPQ_CONNECTION_ENV = [
  'PGHOST',
  'PGSSLMODE',
  'PGHOSTADDR',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGREQUIREAUTH',
  'PGCHANNELBINDING',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGOPTIONS',
  'PGAPPNAME',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLCERTMODE',
  'PGSSLROOTCERT',
  'PGSSLCRL',
  'PGSSLCRLDIR',
  'PGSSLSNI',
  'PGREQUIREPEER',
  'PGSSLMINPROTOCOLVERSION',
  'PGSSLMAXPROTOCOLVERSION',
  'PGGSSENCMODE',
  'PGKRBSRVNAME',
  'PGGSSLIB',
  'PGGSSDELEGATION',
  'PGCONNECT_TIMEOUT',
  'PGCLIENTENCODING',
  'PGTARGETSESSIONATTRS',
  'PGLOADBALANCEHOSTS',
] as const
const SERVICE_PARAMETERS = new Set([
  'application_name',
  'channel_binding',
  'client_encoding',
  'connect_timeout',
  'dbname',
  'fallback_application_name',
  'gssdelegation',
  'gssencmode',
  'gsslib',
  'host',
  'hostaddr',
  'keepalives',
  'keepalives_count',
  'keepalives_idle',
  'keepalives_interval',
  'krbsrvname',
  'load_balance_hosts',
  'options',
  'password',
  'passfile',
  'port',
  'replication',
  'require_auth',
  'requirepeer',
  'requiressl',
  'sslcert',
  'sslcertmode',
  'sslcrl',
  'sslcrldir',
  'sslkey',
  'ssl_max_protocol_version',
  'ssl_min_protocol_version',
  'sslmode',
  'sslnegotiation',
  'sslpassword',
  'sslrootcert',
  'sslcompression',
  'sslsni',
  'target_session_attrs',
  'tcp_user_timeout',
  'user',
])

type CommandOptions = { env: NodeJS.ProcessEnv }
type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<void>

export type RestorePublication = {
  generation: number
  content_hash: string
  object_key: string
  published_at: number
  observed_at: number
  run_id: string
  item_count: number
  git_sha: string
}

export type RestoreProjection = {
  collections: PublicCollectionItemV1[]
  calendar: PublicCalendarDayV1[]
}

export interface RestoreDatabaseSession {
  /** Holds the target session advisory lock for the whole callback; false means the callback did not run. */
  withSessionLock<T>(work: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>
  isEmpty(): Promise<boolean>
  migrations(): Promise<readonly ({ name: string; checksum: string } | string)[]>
  rowCounts(): Promise<Record<string, number>>
  publication(): Promise<RestorePublication | null>
  snapshotProjection(): Promise<RestoreProjection>
  close(): Promise<void>
}

export interface RestoreDependencies {
  productionUrl: string
  storage: Pick<S3Port, 'get'>
  database: { connect(url: string): Promise<RestoreDatabaseSession> }
  expectedMigrations?: readonly ({ name: string; checksum: string } | string)[]
  tempRoot?: string
  runCommand?: CommandRunner
}

export type RestoreReport = {
  key: string
  size: number
  sha256: string
  migrations: { name: string; checksum: string }[]
  rowCounts: Record<string, number>
  snapshotHash: string
  publication: RestorePublication
}

type WeekdayLabels = { en: string; cn: string; ja: string; id: number }
type BaselineOrdering = {
  collections: Record<'want' | 'watched' | 'watching' | 'on_hold' | 'dropped', number[]>
  calendar: Array<{ weekday: WeekdayLabels; subjectIds: number[] }>
}

function fail(code: string): never {
  throw new Error(code)
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isGitSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function parseBackupKey(key: string): { date: string; timestamp: string; createdAt: string; gitSha: string } {
  const match = /^backups\/postgres\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{8}T\d{9}Z)-([0-9a-f]{40})\.dump$/.exec(key)
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5]) fail('RESTORE_KEY_INVALID')
  const date = `${match[1]}-${match[2]}-${match[3]}`
  const timestamp = match[4]
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`
  const parsed = Date.parse(iso)
  if (!Number.isFinite(parsed)
    || new Date(parsed).toISOString().replace(/[-:.]/g, '') !== timestamp
    || timestamp.slice(0, 4) !== match[1]
    || timestamp.slice(4, 6) !== match[2]
    || timestamp.slice(6, 8) !== match[3]) {
    fail('RESTORE_KEY_INVALID')
  }
  return { date, timestamp, createdAt: iso, gitSha: match[5] }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    fail('RESTORE_MANIFEST_INVALID')
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index])
}

function parseBackupManifest(
  bytes: Uint8Array,
  key: string,
  dump: Uint8Array,
  provenance: ReturnType<typeof parseBackupKey>,
): { size: number; sha256: string } {
  const value = parseJson(bytes)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('RESTORE_MANIFEST_INVALID')
  const manifest = value as Record<string, unknown>
  const required = ['schema_version', 'run_id', 'git_sha', 'created_at', 'object_key', 'size', 'sha256']
  const keys = Object.keys(manifest)
  if (keys.length !== required.length || required.some((field) => !Object.hasOwn(manifest, field))) {
    fail('RESTORE_MANIFEST_INVALID')
  }
  if (manifest.schema_version !== RESTORE_SCHEMA_VERSION
    || typeof manifest.run_id !== 'string'
    || manifest.run_id.length === 0
    || !isGitSha(manifest.git_sha)
    || !isCanonicalUtc(manifest.created_at)
    || manifest.git_sha !== provenance.gitSha
    || manifest.created_at !== provenance.createdAt
    || manifest.object_key !== key
    || !isSafeInteger(manifest.size)
    || !isSha256(manifest.sha256)
    || !sameBytes(bytes, new TextEncoder().encode(canonicalJson(manifest)))) {
    fail('RESTORE_MANIFEST_INVALID')
  }
  const sha256 = createHash('sha256').update(dump).digest('hex')
  if (manifest.size !== dump.byteLength || manifest.sha256 !== sha256) fail('RESTORE_CHECKSUM_MISMATCH')
  return { size: manifest.size, sha256 }
}

function parseConnectionQuery(search: string): [string, string][] {
  const rawQuery = search.slice(1)
  if (!rawQuery) return []
  const entries = rawQuery.split('&')
  if (entries.at(-1) === '') entries.pop()
  return entries.map((entry) => {
    const separator = entry.indexOf('=')
    if (separator < 0 || entry.indexOf('=', separator + 1) >= 0) fail('RESTORE_TARGET_INVALID')
    try {
      return [decodeURIComponent(entry.slice(0, separator)), decodeURIComponent(entry.slice(separator + 1))]
    } catch {
      fail('RESTORE_TARGET_INVALID')
    }
  })
}

function connectionParts(databaseUrl: string): { host: string; hostaddr: string; port: string; dbname: string; user: string; password: string; query: Map<string, string> } {
  let url: URL
  try {
    url = new URL(databaseUrl)
  } catch {
    fail('RESTORE_TARGET_INVALID')
  }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hash) fail('RESTORE_TARGET_INVALID')
  const entries = parseConnectionQuery(url.search)
  const query = new Map<string, string>()
  for (const [key, value] of entries) {
    if (!SERVICE_PARAMETERS.has(key)) fail('RESTORE_TARGET_INVALID')
    if (query.has(key)) fail('RESTORE_TARGET_INVALID')
    query.set(key, value)
  }
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      fail('RESTORE_TARGET_INVALID')
    }
  }
  const host = query.get('host') ?? decode(url.hostname.replace(/^\[|\]$/g, ''))
  const hostaddr = query.get('hostaddr') ?? ''
  const port = query.get('port') ?? (url.port || '5432')
  const dbname = query.get('dbname') ?? (decode(url.pathname.slice(1)) || query.get('user') || '')
  const user = query.get('user') ?? decode(url.username)
  const password = query.get('password') ?? decode(url.password)
  if (!host || !port || !dbname) fail('RESTORE_TARGET_INVALID')
  return { host, hostaddr, port, dbname, user, password, query }
}

function databaseIdentity(databaseUrl: string): string {
  const parts = connectionParts(databaseUrl)
  return [parts.host.toLowerCase(), parts.hostaddr.toLowerCase(), parts.port, parts.dbname].join('\u0000')
}

function createConnectionServiceFile(databaseUrl: string): string {
  const parts = connectionParts(databaseUrl)
  const parameters = new Map<string, string>()
  if (parts.user) parameters.set('user', parts.user)
  if (parts.password) parameters.set('password', parts.password)
  if (parts.host) parameters.set('host', parts.host)
  if (parts.hostaddr) parameters.set('hostaddr', parts.hostaddr)
  if (parts.port) parameters.set('port', parts.port)
  if (parts.dbname) parameters.set('dbname', parts.dbname)
  for (const [key, value] of parts.query) {
    if (key !== 'user' && key !== 'password' && key !== 'host' && key !== 'hostaddr' && key !== 'port' && key !== 'dbname') {
      parameters.set(key, value)
    }
  }
  const lines = [`[${RESTORE_SERVICE_NAME}]`]
  for (const [key, value] of parameters) {
    if (/\0|\r|\n/.test(value) || /[\t ]$/.test(value)) fail('RESTORE_TARGET_INVALID')
    const line = `${key}=${value}`
    if (Buffer.byteLength(line) + 1 >= 1023) fail('RESTORE_TARGET_INVALID')
    lines.push(line)
  }
  return `${lines.join('\n')}\n`
}

async function ensurePrivateTempRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const root = await lstat(path)
  const currentUid = process.getuid?.()
  if (!root.isDirectory()
    || root.isSymbolicLink()
    || currentUid === undefined
    || root.uid !== currentUid
    || (root.mode & 0o700) !== 0o700
    || (root.mode & 0o077) !== 0) {
    fail('RESTORE_TEMP_UNSAFE')
  }
}

function normalizeMigrations(value: readonly ({ name: string; checksum: string } | string)[]): { name: string; checksum: string }[] {
  return value.map((migration) => typeof migration === 'string'
    ? { name: migration, checksum: '' }
    : { name: migration.name, checksum: migration.checksum })
}

async function expectedMigrations(deps: RestoreDependencies): Promise<{ name: string; checksum: string }[]> {
  if (deps.expectedMigrations) return normalizeMigrations(deps.expectedMigrations)
  try {
    const directory = new URL('../postgres/migrations/', import.meta.url)
    const entries = await readdir(directory, { withFileTypes: true })
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.sql')).sort((a, b) => a.name.localeCompare(b.name))
    return Promise.all(files.map(async (entry) => {
      const sql = await readFile(new URL(entry.name, directory))
      return { name: entry.name, checksum: createHash('sha256').update(sql).digest('hex') }
    }))
  } catch {
    fail('RESTORE_MIGRATIONS_INVALID')
  }
}

function validateMigrations(actualValue: readonly ({ name: string; checksum: string } | string)[], expected: readonly { name: string; checksum: string }[]): { name: string; checksum: string }[] {
  const actual = normalizeMigrations(actualValue)
  if (actual.length !== expected.length) fail('RESTORE_MIGRATIONS_INVALID')
  for (let index = 0; index < expected.length; index += 1) {
    const got = actual[index]
    const want = expected[index]
    if (!got || !want || got.name !== want.name || (want.checksum !== '' && got.checksum !== want.checksum)) fail('RESTORE_MIGRATIONS_INVALID')
  }
  return actual
}

function validateRowCounts(value: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {}
  for (const table of REQUIRED_ROW_TABLES) {
    if (!isSafeInteger(value[table])) fail('RESTORE_ROW_COUNTS_INVALID')
    result[table] = value[table]!
  }
  if (result.publications !== 1) fail('RESTORE_ROW_COUNTS_INVALID')
  return result
}

function validatePublication(value: RestorePublication | null): RestorePublication {
  if (!value
    || !isSafeInteger(value.generation, 1)
    || !isSha256(value.content_hash)
    || value.object_key !== snapshotKey(value.generation, value.content_hash)
    || !isSafeInteger(value.published_at)
    || !isSafeInteger(value.observed_at)
    || typeof value.run_id !== 'string'
    || value.run_id.length === 0
    || !isSafeInteger(value.item_count)
    || !isGitSha(value.git_sha)) {
    fail('RESTORE_BASELINE_INVALID')
  }
  return value
}

async function readBaseline(deps: RestoreDependencies, publication: RestorePublication): Promise<PublicSnapshotV1> {
  const bytes = await deps.storage.get(publication.object_key)
  if (!bytes) fail('RESTORE_BASELINE_INVALID')
  let snapshot: PublicSnapshotV1
  try {
    snapshot = await parsePublicSnapshotV1(parseJson(bytes))
  } catch {
    fail('RESTORE_BASELINE_INVALID')
  }
  if (!sameBytes(bytes, canonicalSnapshotBytes(snapshot))
    || snapshotObjectKey(snapshot) !== publication.object_key
    || snapshot.generation !== publication.generation
    || snapshot.content_hash !== publication.content_hash
    || snapshot.published_at !== publication.published_at
    || snapshot.summary._total !== publication.item_count) {
    fail('RESTORE_BASELINE_INVALID')
  }
  return snapshot
}

function snapshotObjectKey(snapshot: PublicSnapshotV1): string {
  return snapshotKey(snapshot.generation, snapshot.content_hash)
}

function baselineOrdering(snapshot: PublicSnapshotV1): BaselineOrdering {
  const collectionKeys = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
  const collections = {} as BaselineOrdering['collections']
  const seenCollections = new Set<number>()
  for (const key of collectionKeys) {
    const values = snapshot.collections[key].map((item) => item.subject_id)
    if (new Set(values).size !== values.length || values.some((id) => !isSafeInteger(id, 1)) || values.some((id) => seenCollections.has(id))) {
      fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    }
    values.forEach((id) => seenCollections.add(id))
    collections[key] = values
  }

  const seenDays = new Set<number>()
  const calendar = snapshot.calendar.map((day) => {
    const weekday = day.weekday
    const subjectIds = day.items.map((item) => item.subject_id)
    if (!isSafeInteger(weekday.id, 1)
      || weekday.id > 7
      || seenDays.has(weekday.id)
      || new Set(subjectIds).size !== subjectIds.length
      || subjectIds.some((id) => !isSafeInteger(id, 1))) {
      fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    }
    seenDays.add(weekday.id)
    return {
      weekday: { en: weekday.en, cn: weekday.cn, ja: weekday.ja, id: weekday.id },
      subjectIds,
    }
  })
  return { collections, calendar }
}

function identityMap<T extends { subject_id: number }>(items: readonly T[], kind: string): Map<number, T> {
  const map = new Map<number, T>()
  for (const item of items) {
    if (!isSafeInteger(item.subject_id, 1) || map.has(item.subject_id)) fail(`RESTORE_SNAPSHOT_IDENTITY_MISMATCH`)
    map.set(item.subject_id, item)
  }
  if (map.size !== items.length) fail(`RESTORE_SNAPSHOT_IDENTITY_MISMATCH`)
  return map
}

function reorderProjection(projection: RestoreProjection, ordering: BaselineOrdering): RestoreProjection {
  if (!projection || !Array.isArray(projection.collections) || !Array.isArray(projection.calendar)) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
  const byType = new Map<number, PublicCollectionItemV1[]>()
  for (const item of projection.collections) {
    if (!isSafeInteger(item.subject_id, 1) || !isSafeInteger(item.collection_type, 1) || item.collection_type > 5) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    const values = byType.get(item.collection_type) ?? []
    values.push(item)
    byType.set(item.collection_type, values)
  }
  const collectionKeys = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
  const reorderedCollections: PublicCollectionItemV1[] = []
  collectionKeys.forEach((key, index) => {
    const expected = ordering.collections[key]
    const values = byType.get(index + 1) ?? []
    const map = identityMap(values, 'collection')
    if (map.size !== expected.length || expected.some((id) => !map.has(id))) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    reorderedCollections.push(...expected.map((id) => map.get(id)!))
  })
  if ([...byType.values()].reduce((sum, values) => sum + values.length, 0) !== reorderedCollections.length) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')

  const days = identityMap(projection.calendar.map((day) => {
    if (!day || !day.weekday || !isSafeInteger(day.weekday.id, 1) || day.weekday.id > 7) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    return { day, subject_id: day.weekday.id }
  }), 'calendar')
  if (days.size !== ordering.calendar.length || ordering.calendar.some(({ weekday }) => !days.has(weekday.id))) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
  const reorderedCalendar = ordering.calendar.map(({ weekday, subjectIds }) => {
    const current = days.get(weekday.id)!.day
    const items = identityMap(current.items, 'calendar item')
    if (items.size !== subjectIds.length || subjectIds.some((id) => !items.has(id))) fail('RESTORE_SNAPSHOT_IDENTITY_MISMATCH')
    return {
      // The labels are the only values allowed to come from the immutable baseline.
      weekday,
      items: subjectIds.map((id) => items.get(id)! ),
    }
  })
  return { collections: reorderedCollections, calendar: reorderedCalendar }
}

async function rebuildSnapshot(
  session: RestoreDatabaseSession,
  publication: RestorePublication,
  baseline: PublicSnapshotV1,
): Promise<PublicSnapshotV1> {
  const projection = await session.snapshotProjection()
  const ordered = reorderProjection(projection, baselineOrdering(baseline))
  try {
    return await buildPublicSnapshot({
      collections: ordered.collections,
      calendar: ordered.calendar,
      published_at: publication.published_at,
    }, publication.generation)
  } catch {
    fail('RESTORE_SNAPSHOT_INVALID')
  }
}

function defaultCommandRunner(command: string, args: readonly string[], options: CommandOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: options.env, stdio: 'ignore' })
    child.once('error', () => reject(new Error('RESTORE_COMMAND_FAILED')))
    child.once('exit', (code: number | null) => code === 0 ? resolve() : reject(new Error('RESTORE_COMMAND_FAILED')))
  })
}

async function closeSession(session: RestoreDatabaseSession | undefined): Promise<void> {
  if (!session) return
  try {
    await session.close()
  } catch {
    fail('RESTORE_DATABASE_INVALID')
  }
}

/**
 * Restore one verified custom-format dump into an injected, disposable target.
 * The target URL is supplied as a function so no CLI/env contract or URL-bearing
 * argument is introduced here; Task 9.3 owns the executable operator command.
 */
export async function restoreVerify(
  deps: RestoreDependencies,
  key: string,
  targetUrl: () => string,
): Promise<RestoreReport> {
  const provenance = parseBackupKey(key)
  if (typeof targetUrl !== 'function') fail('RESTORE_TARGET_INVALID')

  const manifestKey = key.slice(0, -'.dump'.length) + '.json'
  const dump = await deps.storage.get(key)
  const manifestBytes = await deps.storage.get(manifestKey)
  if (!dump) fail('RESTORE_DUMP_MISSING')
  if (!manifestBytes) fail('RESTORE_MANIFEST_INVALID')
  const manifest = parseBackupManifest(manifestBytes, key, dump, provenance)

  let target: string
  try {
    target = targetUrl()
  } catch {
    fail('RESTORE_TARGET_INVALID')
  }
  if (typeof target !== 'string' || !target.trim()) fail('RESTORE_TARGET_INVALID')
  if (databaseIdentity(target) === databaseIdentity(deps.productionUrl)) fail('RESTORE_TARGET_IS_PRODUCTION')

  let emptySession: RestoreDatabaseSession | undefined
  try {
    emptySession = await deps.database.connect(target)
    const locked = await emptySession.withSessionLock(async () => {
      if (!await emptySession!.isEmpty()) fail('RESTORE_TARGET_NOT_EMPTY')

      let temporaryDirectory: string | undefined
      try {
        const tempRoot = deps.tempRoot ?? RESTORE_TEMP_ROOT
        await ensurePrivateTempRoot(tempRoot)
        temporaryDirectory = await mkdtemp(join(tempRoot, 'restore-'))
        await chmod(temporaryDirectory, 0o700)
        const dumpPath = join(temporaryDirectory, 'database.dump')
        const serviceFile = join(temporaryDirectory, 'pg_service.conf')
        await writeFile(dumpPath, dump, { flag: 'wx', mode: 0o600 })
        await chmod(dumpPath, 0o600)
        await writeFile(serviceFile, createConnectionServiceFile(target), { flag: 'wx', mode: 0o600 })
        await chmod(serviceFile, 0o600)
        const env: NodeJS.ProcessEnv = { ...process.env }
        for (const variable of LIBPQ_CONNECTION_ENV) delete env[variable]
        delete env.DATABASE_URL
        env.PGSERVICE = RESTORE_SERVICE_NAME
        env.PGSERVICEFILE = serviceFile
        await (deps.runCommand ?? defaultCommandRunner)('pg_restore', [
          `--dbname=service=${RESTORE_SERVICE_NAME}`,
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          dumpPath,
        ], { env })

        let restored: RestoreDatabaseSession | undefined
        try {
          restored = await deps.database.connect(target)
          const publication = validatePublication(await restored.publication())
          const baseline = await readBaseline(deps, publication)
          const migrations = validateMigrations(await restored.migrations(), await expectedMigrations(deps))
          const rowCounts = validateRowCounts(await restored.rowCounts())
          const snapshot = await rebuildSnapshot(restored, publication, baseline)
          if (snapshot.content_hash !== publication.content_hash) fail('RESTORE_SNAPSHOT_HASH_MISMATCH')
          return {
            key,
            size: manifest.size,
            sha256: manifest.sha256,
            migrations,
            rowCounts,
            snapshotHash: snapshot.content_hash,
            publication,
          }
        } finally {
          await closeSession(restored)
        }
      } catch (error) {
        if (error instanceof Error && /^RESTORE_[A-Z0-9_]+$/.test(error.message)) throw error
        fail('RESTORE_FAILED')
      } finally {
        if (temporaryDirectory) {
          try {
            await rm(temporaryDirectory, { recursive: true, force: true })
          } catch {
            fail('RESTORE_CLEANUP_FAILED')
          }
        }
      }
      fail('RESTORE_FAILED')
    })
    if (!locked.acquired) fail('RESTORE_TARGET_LOCK_UNAVAILABLE')
    if (!locked.value) fail('RESTORE_FAILED')
    return locked.value
  } catch (error) {
    if (error instanceof Error && /^RESTORE_[A-Z0-9_]+$/.test(error.message)) throw error
    fail('RESTORE_FAILED')
  } finally {
    await closeSession(emptySession)
  }
}
