import { copyFileSync, existsSync } from 'node:fs'
import { openBuilderDatabase } from '@airing-cal/v3-builder'
import { readCheckpointBackupConfig } from './portable-checkpoint-backup.ts'

export function restoreBuilderCheckpoint(
  backupPath: string,
  env: Record<string, string | undefined> = process.env,
  force = false,
): { sqlitePath: string; backupPath: string } {
  const trimmedBackup = backupPath.trim()
  if (!trimmedBackup) throw new Error('Backup path argument is required')
  const { sqlitePath } = readCheckpointBackupConfig(env)
  if (existsSync(sqlitePath) && !force) {
    throw new Error('Target SQLite exists; re-run with --force to overwrite')
  }
  copyFileSync(trimmedBackup, sqlitePath)
  const db = openBuilderDatabase(sqlitePath)
  db.close()
  return { sqlitePath, backupPath: trimmedBackup }
}

if (process.argv[1]?.endsWith('portable-checkpoint-restore.ts')) {
  const force = process.argv.includes('--force')
  const backupPath = process.argv.find((arg, index) => index >= 2 && !arg.startsWith('--'))
  try {
    if (!backupPath) throw new Error('Usage: portable-checkpoint-restore.ts <backup.sqlite> [--force]')
    const result = restoreBuilderCheckpoint(backupPath, process.env, force)
    console.log(JSON.stringify({ status: 'succeeded', stage: 'checkpoint_restore', ...result }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'restore_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'checkpoint_restore', message }))
    process.exit(1)
  }
}
