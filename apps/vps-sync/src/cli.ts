import { createBackup, type BackupDependencies } from './backup/backup.js'
import type { RunDependencies, RunRequest, RunResult } from './contracts.js'
import { runOnce } from './run.js'

export type RunOnceWithBackupDependencies = Omit<RunDependencies, 'backup'> & {
  backupConfig: BackupDependencies
}

/** Injectable production composition; the executable sync command is enabled with its notifier in Task 6.2. */
export async function runOnceWithBackup(
  deps: RunOnceWithBackupDependencies,
  request: RunRequest,
): Promise<RunResult> {
  if (typeof deps.notify !== 'function') throw new Error('NOTIFIER_REQUIRED')

  const runDependencies: RunDependencies = {
    ...deps,
    backup: async (context) => {
      await createBackup(deps.backupConfig, { runId: context.runId, gitSha: deps.gitSha })
    },
  }
  return runOnce(runDependencies, request)
}
