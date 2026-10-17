import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBuilderDatabase, SyncRunStore } from '@airing-cal/v3-builder'
import { backupBuilderCheckpoint } from './portable-checkpoint-backup.ts'

test('backupBuilderCheckpoint writes a readable sqlite file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-backup-'))
  const sqlitePath = join(dir, 'builder.sqlite')
  const db = openBuilderDatabase(sqlitePath)
  const runs = new SyncRunStore(db)
  runs.startRun('run-a', 'incremental', 1)
  runs.finishRun('run-a', 'succeeded', null, 2)
  db.close()

  const { backupPath } = backupBuilderCheckpoint({
    AIRINGCAL_BUILDER_SQLITE_PATH: sqlitePath,
    AIRINGCAL_BUILDER_BACKUP_DIR: join(dir, 'backups'),
  })
  assert.ok(readFileSync(backupPath).byteLength > 0)
  const restored = openBuilderDatabase(backupPath)
  const row = restored.prepare('SELECT run_id FROM sync_runs WHERE run_id = ?').get('run-a') as { run_id: string }
  assert.equal(row.run_id, 'run-a')
  restored.close()
})
