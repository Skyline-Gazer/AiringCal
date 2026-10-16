import { DatabaseSync } from 'node:sqlite'

export type SyncRunMode = 'incremental' | 'full'
export type SyncRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface SyncRunRecord {
  run_id: string
  mode: SyncRunMode
  status: SyncRunStatus
  started_at_unix: number
  finished_at_unix: number | null
  detail_json: string | null
}

export class SyncRunStore {
  constructor(private readonly db: DatabaseSync) {}

  startRun(runId: string, mode: SyncRunMode, startedAtUnix = Math.floor(Date.now() / 1000)): void {
    this.db.prepare(
      `INSERT INTO sync_runs (run_id, mode, status, started_at_unix, finished_at_unix, detail_json)
       VALUES (?, ?, 'running', ?, NULL, NULL)`,
    ).run(runId, mode, startedAtUnix)
  }

  finishRun(
    runId: string,
    status: Exclude<SyncRunStatus, 'running'>,
    detailJson: string | null,
    finishedAtUnix = Math.floor(Date.now() / 1000),
  ): void {
    const changes = this.db.prepare(
      `UPDATE sync_runs
       SET status = ?, finished_at_unix = ?, detail_json = ?
       WHERE run_id = ? AND status = 'running'`,
    ).run(status, finishedAtUnix, detailJson, runId).changes
    if (changes !== 1) throw new Error(`Sync run not running: ${runId}`)
  }

  latestRun(): SyncRunRecord | null {
    const row = this.db.prepare(
      `SELECT run_id, mode, status, started_at_unix, finished_at_unix, detail_json
       FROM sync_runs ORDER BY started_at_unix DESC LIMIT 1`,
    ).get() as SyncRunRecord | undefined
    return row ?? null
  }
}
