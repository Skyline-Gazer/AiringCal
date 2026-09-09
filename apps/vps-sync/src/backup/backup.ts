import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson } from '@airing-cal/storage'
import type { S3Port } from '../publication/s3.ts'

export type BackupResult = {
  objectKey: string
  manifestKey: string
  size: number
  sha256: string
}

type Command = (command: string, args: readonly string[], environment: Record<string, string | undefined>) => Promise<void>

type BackupDependencies = {
  databaseUrl: string
  gitSha: string
  now(): number
  command: Command
  files: {
    makeDirectory(): Promise<string>
    read(path: string): Promise<Uint8Array>
    remove(path: string): Promise<void>
  }
  s3: Pick<S3Port, 'put'>
}

function pgEnvironment(databaseUrl: string): Record<string, string | undefined> {
  const url = new URL(databaseUrl)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('BACKUP_DATABASE_URL_INVALID')
  const name = url.pathname.slice(1)
  if (!url.hostname || !name) throw new Error('BACKUP_DATABASE_URL_INVALID')
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(name),
  }
}

function timestamp(now: number): string { return new Date(now).toISOString().replace(/[.:]/g, '-') }

function keys(now: number, gitSha: string): { objectKey: string; manifestKey: string; createdAt: string } {
  if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('BACKUP_GIT_SHA_INVALID')
  const createdAt = new Date(now).toISOString()
  const [year, month, day] = createdAt.slice(0, 10).split('-')
  const stem = `backups/postgres/${year}/${month}/${day}/${timestamp(now)}-${gitSha}`
  return { objectKey: `${stem}.dump`, manifestKey: `${stem}.json`, createdAt }
}

export function createBackup(deps: BackupDependencies): (input: { runId: string }) => Promise<BackupResult> {
  return async ({ runId }) => {
    const directory = await deps.files.makeDirectory()
    try {
      const path = join(directory, 'backup.dump')
      await deps.command('pg_dump', ['--format=custom', `--file=${path}`], pgEnvironment(deps.databaseUrl))
      const bytes = await deps.files.read(path)
      const { objectKey, manifestKey, createdAt } = keys(deps.now(), deps.gitSha)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      await deps.s3.put(objectKey, bytes)
      const manifest = canonicalJson({ schema_version: 1, run_id: runId, git_sha: deps.gitSha, created_at: createdAt, object_key: objectKey, size: bytes.byteLength, sha256 })
      await deps.s3.put(manifestKey, new TextEncoder().encode(manifest))
      return { objectKey, manifestKey, size: bytes.byteLength, sha256 }
    } finally {
      await deps.files.remove(directory)
    }
  }
}

export function createProductionBackup(input: Pick<BackupDependencies, 'databaseUrl' | 'gitSha' | 'now' | 's3'>): (run: { runId: string }) => Promise<BackupResult> {
  return createBackup({
    ...input,
    command: (command, args, environment) => new Promise((resolve, reject) => {
      const child = spawn(command, args, { env: { ...process.env, ...environment }, stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('BACKUP_DUMP_FAILED')))
    }),
    files: {
      makeDirectory: async () => { await mkdir('/tmp/airing-cal', { recursive: true }); return mkdtemp('/tmp/airing-cal/backup-') },
      read: readFile,
      remove: async (path) => { await rm(path, { recursive: true, force: true }) },
    },
  })
}
