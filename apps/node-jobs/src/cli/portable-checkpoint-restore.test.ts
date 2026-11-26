import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBuilderDatabase, SyncRunStore } from '@airing-cal/v3-builder'
import { backupBuilderCheckpoint } from './portable-checkpoint-backup.ts'
import { restoreBuilderCheckpoint } from './portable-checkpoint-restore.ts'

test('restoreBuilderCheckpoint refuses overwrite without force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-restore-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const db = openBuilderDatabase(sqlitePath)
  db.close()
  const { backupPath } = backupBuilderCheckpoint({
    AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
    AIRINGCAL_BUILDER_BACKUP_DIR: join(dir, 'backups'),
  })
  assert.throws(
    () => restoreBuilderCheckpoint(backupPath, { AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath }),
    /force/,
  )
})

test('restoreBuilderCheckpoint replaces sqlite from backup with force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-restore-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const db = openBuilderDatabase(sqlitePath)
  const runs = new SyncRunStore(db)
  runs.startRun('before-restore', 'full', 1)
  runs.finishRun('before-restore', 'succeeded', null, 2)
  db.close()
  const { backupPath } = backupBuilderCheckpoint({
    AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
    AIRINGCAL_BUILDER_BACKUP_DIR: join(dir, 'backups'),
  })

  const wiped = openBuilderDatabase(sqlitePath)
  wiped.exec('DELETE FROM sync_runs')
  wiped.close()

  restoreBuilderCheckpoint(backupPath, { AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath }, true)
  const restored = openBuilderDatabase(sqlitePath)
  const row = restored.prepare('SELECT run_id FROM sync_runs WHERE run_id = ?').get('before-restore') as { run_id: string }
  assert.equal(row.run_id, 'before-restore')
  restored.close()
})
