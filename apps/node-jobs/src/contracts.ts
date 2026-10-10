export type JobExitStatus = 'success' | 'skipped' | 'failed'

export interface JobSummary {
  job: 'airingcal-sync' | 'airingcal-backup'
  status: JobExitStatus
  message: string
}

export function exitCode(summary: JobSummary): number {
  return summary.status === 'failed' ? 1 : 0
}
