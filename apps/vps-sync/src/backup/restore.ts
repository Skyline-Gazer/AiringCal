import { createHash } from 'node:crypto'
import type { S3Port } from '../publication/s3.ts'

const backupKey = /^backups\/postgres\/\d{4}\/\d{2}\/\d{2}\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{40}\.dump$/

export type RestoreReport = { schemaVersion: number; rowCounts: Record<string, number>; snapshotHash: string }

export type RestoreDependencies = {
  productionDatabaseUrl: string
  targetDatabaseUrl: string
  s3: Pick<S3Port, 'get'>
  files: { makeDirectory(): Promise<string>; write(path: string, bytes: Uint8Array): Promise<void>; remove(path: string): Promise<void> }
  database: { isEmpty(): Promise<boolean>; close(): Promise<void> }
  command(command: string, args: readonly string[], environment: Record<string, string | undefined>): Promise<void>
  verify(): Promise<RestoreReport>
}

function databaseIdentity(value: string): { identity: string; environment: Record<string, string | undefined> } {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('RESTORE_DATABASE_URL_INVALID') }
  if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('RESTORE_DATABASE_URL_INVALID')
  }
  const query = [...url.searchParams]
  const sslmodes = query.filter(([key]) => key === 'sslmode')
  if (query.length !== sslmodes.length || sslmodes.length > 1 || sslmodes[0]?.[1] === '') throw new Error('RESTORE_DATABASE_URL_INVALID')
  const port = url.port || '5432'
  return {
    identity: `${url.hostname.toLowerCase()}:${port}/${decodeURIComponent(url.pathname.slice(1))}`,
    environment: {
      PGHOST: url.hostname, PGPORT: port, PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), ...(sslmodes.length ? { PGSSLMODE: sslmodes[0]![1] } : {}),
    },
  }
}

function parseManifest(bytes: Uint8Array, key: string, dump: Uint8Array): void {
  let manifest: unknown
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('RESTORE_MANIFEST_INVALID') }
  if (typeof manifest !== 'object' || manifest === null) throw new Error('RESTORE_MANIFEST_INVALID')
  const value = manifest as Record<string, unknown>
  const checksum = createHash('sha256').update(dump).digest('hex')
  if (value.schema_version !== 1 || value.object_key !== key || value.size !== dump.byteLength || value.sha256 !== checksum) {
    throw new Error(value.sha256 !== checksum ? 'RESTORE_CHECKSUM_MISMATCH' : 'RESTORE_MANIFEST_INVALID')
  }
}

function validReport(report: RestoreReport): boolean {
  return Number.isSafeInteger(report.schemaVersion) && report.schemaVersion > 0
    && /^[a-f0-9]{64}$/.test(report.snapshotHash)
    && Object.values(report.rowCounts).every((count) => Number.isSafeInteger(count) && count >= 0)
}

/** Restores a single verified archive into an already-connected, explicitly empty target. */
export async function restoreVerify(deps: RestoreDependencies, key: string): Promise<RestoreReport> {
  if (!backupKey.test(key)) throw new Error('RESTORE_BACKUP_KEY_INVALID')
  let directory: string | undefined
  try {
    const production = databaseIdentity(deps.productionDatabaseUrl)
    const target = databaseIdentity(deps.targetDatabaseUrl)
    if (production.identity === target.identity) throw new Error('RESTORE_TARGET_PRODUCTION')
    if (!await deps.database.isEmpty()) throw new Error('RESTORE_TARGET_NOT_EMPTY')
    const [dump, manifest] = await Promise.all([deps.s3.get(key), deps.s3.get(key.replace(/\.dump$/, '.json'))])
    if (!dump || !manifest) throw new Error('RESTORE_BACKUP_MISSING')
    parseManifest(manifest, key, dump)
    directory = await deps.files.makeDirectory()
    const path = `${directory}/backup.dump`
    await deps.files.write(path, dump)
    await deps.command('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', '--format=c', path], target.environment)
    const report = await deps.verify()
    if (!validReport(report)) throw new Error('RESTORE_VERIFICATION_FAILED')
    return report
  } finally {
    if (directory) await deps.files.remove(directory)
    await deps.database.close()
  }
}
