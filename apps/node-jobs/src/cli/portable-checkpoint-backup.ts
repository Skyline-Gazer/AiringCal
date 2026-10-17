import { mkdirSync } from 'node:fs'
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
    console.log(JSON.stringify({ status: 'succeeded', stage: 'checkpoint_backup', ...result }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'backup_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'checkpoint_backup', message }))
    process.exit(1)
  }
}
