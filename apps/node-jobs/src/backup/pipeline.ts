import { createHash } from 'node:crypto'
import { open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import { fail, isJobError } from '../adapters/errors.ts'
import type { JobLease } from '../adapters/job-lease.ts'
import { acquireJobLease } from '../adapters/job-lease.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import type { RunContext } from '../adapters/run-context.ts'
import { exportPoll } from './export-poll.ts'

export type BackupRunStatus = 'skipped' | 'ok' | 'failed'

export interface BackupPipelineResult {
  status: BackupRunStatus
  stage: string
  bytes?: number
}

export interface BackupPipelineDeps {
  run: RunContext
  db: CloudflareD1Client
  store: R2Store
  leaseName: string
  leaseSeconds: number
  stateDir: string
  now(): number
  wait(ms: number): Promise<void>
}

const MAX_SQL_BYTES = 256 * 1024 * 1024
const MAX_EXPORT_POLLS = 36
const POLL_INTERVAL_MS = 5000
const DOWNLOAD_TIMEOUT_MS = 20_000
const LEASE_NAME = 'airingcal-data-plane'
const LEASE_SECONDS = 900

const SQL_MARKER = /\b(?:PRAGMA|CREATE TABLE|INSERT INTO|BEGIN TRANSACTION)\b/i

async function downloadExportSql(run: RunContext, url: string, filePath: string): Promise<{ length: number; sha256: string }> {
  run.guard(DOWNLOAD_TIMEOUT_MS + 1000)
  const response = await fetch(url, {
    signal: AbortSignal.any([run.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  })
  if (!response.ok || !response.body) fail('D1_EXPORT_DOWNLOAD_FAILED', response.status)
  const declared = response.headers.get('content-length')
  if (declared && (!Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_SQL_BYTES)) {
    await response.body.cancel()
    fail('D1_EXPORT_TOO_LARGE')
  }
  const handle = await open(filePath, 'wx', 0o600)
  const digest = createHash('sha256')
  let length = 0
  let prefix = ''
  const reader = response.body.getReader()
  try {
    while (true) {
      run.guard(DOWNLOAD_TIMEOUT_MS + 1000)
      const part = await reader.read()
      if (part.done) break
      length += part.value.length
      if (length > MAX_SQL_BYTES) fail('D1_EXPORT_TOO_LARGE')
      digest.update(part.value)
      if (prefix.length < 8192) {
        prefix += Buffer.from(part.value).toString('utf8').slice(0, 8192 - prefix.length)
      }
      await handle.write(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    await handle.close()
  }
  if (!length || !SQL_MARKER.test(prefix) || /^\s*</.test(prefix)) fail('D1_EXPORT_SQL_INVALID')
  return { length, sha256: digest.digest('hex') }
}

export async function runBackupPipeline(deps: BackupPipelineDeps): Promise<BackupPipelineResult> {
  let lease: JobLease | null = null
  const filePath = join(deps.stateDir, `airingcal-backup-${deps.run.owner}.sql`)
  try {
    lease = await acquireJobLease(deps.db, deps.run, deps.leaseName, deps.leaseSeconds)
    if (!lease) {
      return { status: 'skipped', stage: 'lease_busy' }
    }

    let result = exportPoll(await deps.db.export({ output_format: 'polling' }))
    for (let poll = 0; !('url' in result) && poll < MAX_EXPORT_POLLS; poll++) {
      await lease.guard()
      await deps.wait(POLL_INTERVAL_MS)
      result = exportPoll(await deps.db.export({
        output_format: 'polling',
        current_bookmark: result.bookmark,
      }))
    }
    if (!('url' in result)) fail('D1_EXPORT_TIMEOUT')

    await lease.guard()
    const { length, sha256 } = await downloadExportSql(deps.run, result.url, filePath)
    const key = `backups/d1/${new Date(deps.now()).toISOString().replaceAll(':', '-')}-${deps.run.owner}.sql`

    await lease.guard()
    const bytes = await readFile(filePath)
    await deps.store.verifiedPut(key, bytes, 'application/sql')

    await lease.guard()
    const readback = await deps.store.get(key, length)
    if (!readback || readback.byteLength !== length || createHash('sha256').update(readback).digest('hex') !== sha256) {
      fail('BACKUP_READBACK_MISMATCH')
    }

    return { status: 'ok', stage: 'complete', bytes: length }
  } catch (error) {
    if (isJobError(error)) throw error
    throw fail('REQUEST_FAILED', undefined, { cause: error })
  } finally {
    await rm(filePath, { force: true }).catch(() => undefined)
    if (lease) await lease.release().catch(() => undefined)
  }
}

export function defaultBackupLeaseName(): string {
  return LEASE_NAME
}

export function defaultBackupLeaseSeconds(): number {
  return LEASE_SECONDS
}

export function defaultBackupStateDir(): string {
  return process.env.QL_DATA_DIR?.trim() || tmpdir()
}
