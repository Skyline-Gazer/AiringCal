import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { canonicalJson } from '@airing-cal/storage'
import type { S3Port, S3StreamPort } from '../publication/s3.js'

const BACKUP_TEMP_ROOT = '/tmp/airing-cal'
const BACKUP_SCHEMA_VERSION = 1
const BACKUP_SERVICE_NAME = 'airing-cal-backup'
const LIBPQ_CONNECTION_ENV = [
  'PGHOST',
  'PGSSLNEGOTIATION',
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
  'PGSSLMODE',
  'PGREQUIRESSL',
  'PGSSLCOMPRESSION',
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

export type BackupResult = {
  dumpKey: string
  manifestKey: string
  size: number
  sha256: string
}

export type BackupRun = { runId: string; gitSha: string }

type CommandOptions = { env: NodeJS.ProcessEnv }
type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<void>

export interface BackupDependencies {
  databaseUrl: string
  storage: Pick<S3Port, 'put'> & Pick<S3StreamPort, 'putStream'>
  now?: () => number
  tempRoot?: string
  runCommand?: CommandRunner
}

async function ensurePrivateTempRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const root = await lstat(path)
  const currentUid = process.getuid?.()
  if (
    !root.isDirectory()
    || root.isSymbolicLink()
    || currentUid === undefined
    || root.uid !== currentUid
    || (root.mode & 0o700) !== 0o700
    || (root.mode & 0o077) !== 0
  ) {
    throw new Error('BACKUP_FAILED')
  }
}

function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: options.env, stdio: 'ignore' })
    child.once('error', () => reject(new Error('BACKUP_FAILED')))
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('BACKUP_FAILED')))
  })
}

function parseUriQuery(search: string): [string, string][] {
  const rawQuery = search.slice(1)
  if (!rawQuery) return []

  const entries = rawQuery.split('&')
  if (entries.at(-1) === '') entries.pop()
  return entries.map((entry) => {
    const separator = entry.indexOf('=')
    if (separator < 0 || entry.indexOf('=', separator + 1) >= 0) throw new Error('BACKUP_FAILED')
    return [decodeURIComponent(entry.slice(0, separator)), decodeURIComponent(entry.slice(separator + 1))]
  })
}

function createConnectionServiceFile(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hash) {
    throw new Error('BACKUP_FAILED')
  }

  const queryEntries = parseUriQuery(url.search)
  if (queryEntries.some(([key]) => key === 'ssl') && queryEntries.some(([key]) => key === 'sslmode')) {
    throw new Error('BACKUP_FAILED')
  }
  const query = new Map<string, string>()
  for (const [key, value] of queryEntries) {
    if (key === 'ssl') {
      if (value === 'true' || value === '1') query.set('sslmode', 'require')
      else if (value === 'false' || value === '0') query.set('sslmode', 'disable')
      else throw new Error('BACKUP_FAILED')
      continue
    }
    // pg-connection-string treats this as a driver-only compatibility switch.
    if (key === 'uselibpqcompat' && (value === 'true' || value === 'false')) continue
    if (!SERVICE_PARAMETERS.has(key)) throw new Error('BACKUP_FAILED')
    query.set(key, value)
  }

  const parameters = new Map<string, string>()
  const queryOr = (key: string, fallback: string) => query.has(key) ? query.get(key)! : fallback
  const hostFromUrl = decodeURIComponent(url.hostname.replace(/^\[|\]$/g, ''))
  const user = queryOr('user', decodeURIComponent(url.username))
  const password = queryOr('password', decodeURIComponent(url.password))
  const host = queryOr('host', hostFromUrl)
  const port = queryOr('port', url.port)
  const database = decodeURIComponent(url.pathname.slice(1))

  if (user) parameters.set('user', user)
  if (password) parameters.set('password', password)
  if (host) parameters.set('host', host)
  if (port) parameters.set('port', port)
  if (database) parameters.set('dbname', database)
  else if (user) parameters.set('dbname', user)
  for (const [key, value] of query) {
    if (key !== 'user' && key !== 'password' && key !== 'host' && key !== 'port') {
      parameters.set(key, value)
    }
  }

  const lines = [`[${BACKUP_SERVICE_NAME}]`]
  for (const [key, value] of parameters) {
    if (/[\0\r\n]/.test(value) || /[\t ]$/.test(value)) throw new Error('BACKUP_FAILED')
    const line = `${key}=${value}`
    if (Buffer.byteLength(line) + 1 >= 1023) throw new Error('BACKUP_FAILED')
    lines.push(line)
  }
  return `${lines.join('\n')}\n`
}

export async function createBackup(deps: BackupDependencies, run: BackupRun): Promise<BackupResult> {
  if (typeof deps.databaseUrl !== 'string' || !deps.databaseUrl.trim() || !/^[a-f0-9]{40}$/.test(run.gitSha)) {
    throw new Error('BACKUP_FAILED')
  }

  const createdAt = new Date((deps.now ?? Date.now)()).toISOString()
  const [year, month, day] = createdAt.slice(0, 10).split('-')
  const timestamp = createdAt.replace(/[-:.]/g, '')
  const baseKey = `backups/postgres/${year}/${month}/${day}/${timestamp}-${run.gitSha}`
  const dumpKey = `${baseKey}.dump`
  const manifestKey = `${baseKey}.json`
  let temporaryDirectory: string | undefined

  try {
    const tempRoot = deps.tempRoot ?? BACKUP_TEMP_ROOT
    await ensurePrivateTempRoot(tempRoot)
    temporaryDirectory = await mkdtemp(join(tempRoot, 'backup-'))
    await chmod(temporaryDirectory, 0o700)
    const serviceFile = join(temporaryDirectory, 'pg_service.conf')
    await writeFile(serviceFile, createConnectionServiceFile(deps.databaseUrl), { flag: 'wx', mode: 0o600 })
    await chmod(serviceFile, 0o600)
    const dumpPath = join(temporaryDirectory, 'database.dump')
    const env: NodeJS.ProcessEnv = { ...process.env }
    for (const variable of LIBPQ_CONNECTION_ENV) delete env[variable]
    env.PGSERVICE = BACKUP_SERVICE_NAME
    env.PGSERVICEFILE = serviceFile
    delete env.DATABASE_URL
    await (deps.runCommand ?? runCommand)('pg_dump', ['--format=custom', `--file=${dumpPath}`], { env })

    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(dumpPath)) {
      size += chunk.byteLength
      if (!Number.isSafeInteger(size)) throw new Error('BACKUP_FAILED')
      hash.update(chunk)
    }
    if (size === 0) throw new Error('BACKUP_FAILED')
    const sha256 = hash.digest('hex')

    // ponytail: one R2 PutObject is capped at 5 GiB; use multipart if dumps approach that ceiling.
    await deps.storage.putStream(dumpKey, createReadStream(dumpPath), {
      contentLength: size,
      contentType: 'application/octet-stream',
    })
    const manifest = {
      schema_version: BACKUP_SCHEMA_VERSION,
      run_id: run.runId,
      git_sha: run.gitSha,
      created_at: createdAt,
      object_key: dumpKey,
      size,
      sha256,
    }
    await deps.storage.put(manifestKey, new TextEncoder().encode(canonicalJson(manifest)))

    return { dumpKey, manifestKey, size, sha256 }
  } catch {
    throw new Error('BACKUP_FAILED')
  } finally {
    if (temporaryDirectory) {
      try {
        await rm(temporaryDirectory, { recursive: true, force: true })
      } catch {
        throw new Error('BACKUP_FAILED')
      }
    }
  }
}
