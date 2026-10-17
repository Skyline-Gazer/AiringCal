import { mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openBuilderDatabase } from '@airing-cal/v3-builder'

export function readCheckpointBackupConfig(env: Record<string, string | undefined>): {
  sqlitePath: string
  backupDir: string
} {
  const sqlitePath = env.AIRINGCAL_BUILDER_SQLITE_PATH?.trim()
  if (!sqlitePath) {
    throw new Error('AIRINGCAL_BUILDER_SQLITE_PATH is required for checkpoint backup')
  }
  const backupDir = env.AIRINGCAL_BUILDER_BACKUP_DIR?.trim() || join(dirname(sqlitePath), 'backups')
  return { sqlitePath, backupDir }
}

export function checkpointBackupFilename(now = new Date()): string {
  const stamp = now.toISOString().replaceAll(':', '-')
  return `builder-checkpoint-${stamp}.sqlite`
}

const CHECKPOINT_BACKUP_NAME = /^builder-checkpoint-.+\.sqlite$/

export function planCheckpointBackupRetention(
  backupFilenames: readonly string[],
  keepCount: number,
): { keep: string[]; delete: string[] } {
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    throw new Error('keepCount must be a positive integer')
  }
  const candidates = backupFilenames
    .filter((name) => CHECKPOINT_BACKUP_NAME.test(name))
    .sort()
  const keep = candidates.slice(-keepCount)
  const keepSet = new Set(keep)
  const del = candidates.filter((name) => !keepSet.has(name))
  return { keep, delete: del }
}

export function pruneCheckpointBackups(
  env: Record<string, string | undefined> = process.env,
  apply = false,
): { keep: string[]; delete: string[]; deleted: number } {
  const keepCount = Number(env.AIRINGCAL_BUILDER_BACKUP_KEEP?.trim() || '0')
  if (!Number.isFinite(keepCount) || keepCount < 1) {
    return { keep: [], delete: [], deleted: 0 }
  }
  const { backupDir } = readCheckpointBackupConfig(env)
  mkdirSync(backupDir, { recursive: true })
  let names: string[]
  try {
    names = readdirSync(backupDir)
  } catch {
    names = []
  }
  const plan = planCheckpointBackupRetention(names, keepCount)
  let deleted = 0
  if (apply) {
    for (const name of plan.delete) {
      unlinkSync(join(backupDir, name))
      deleted += 1
    }
  }
  return { ...plan, deleted }
}

/** Hot backup of builder SQLite using the engine backup API (WAL-safe read). */
export function backupBuilderCheckpoint(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): { backupPath: string } {
  const { sqlitePath, backupDir } = readCheckpointBackupConfig(env)
  mkdirSync(backupDir, { recursive: true })
  const backupPath = join(backupDir, checkpointBackupFilename(now))
  const db = openBuilderDatabase(sqlitePath)
  try {
    const escaped = backupPath.replaceAll("'", "''")
    db.exec(`VACUUM INTO '${escaped}'`)
  } finally {
    db.close()
  }
  return { backupPath }
}

if (process.argv[1]?.endsWith('portable-checkpoint-backup.ts')) {
  try {
    const result = backupBuilderCheckpoint()
    const pruned = pruneCheckpointBackups(process.env, true)
    console.log(JSON.stringify({
      status: 'succeeded',
      stage: 'checkpoint_backup',
      ...result,
      pruned_delete_count: pruned.delete.length,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'backup_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'checkpoint_backup', message }))
    process.exit(1)
  }
}
