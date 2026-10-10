import type { JobSummary } from '../contracts.ts'

/** Full pipeline: lease → fetch → media → publish (AC-1-03). */
export async function runSync(): Promise<JobSummary> {
  return {
    job: 'airingcal-sync',
    status: 'skipped',
    message: 'node-jobs sync not implemented yet (scaffold only)',
  }
}
