import type { JobSummary } from '../contracts.ts'

/** D1 bookmark export → private R2 (AC-1-04). */
export async function runBackup(): Promise<JobSummary> {
  return {
    job: 'airingcal-backup',
    status: 'skipped',
    message: 'node-jobs backup not implemented yet (scaffold only)',
  }
}
