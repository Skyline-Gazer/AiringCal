import { randomUUID } from 'node:crypto'
import {
  createCloudflareD1Client,
  createR2Store,
  createRunContext,
  isJobError,
  readNodeJobsConfig,
} from '../adapters/index.ts'
import type { JobSummary } from '../contracts.ts'
import {
  defaultBackupLeaseName,
  defaultBackupLeaseSeconds,
  defaultBackupStateDir,
  runBackupPipeline,
} from './pipeline.ts'

/** D1 bookmark export → private R2 (AC-1-04). */
export async function runBackup(env: Record<string, string | undefined> = process.env): Promise<JobSummary> {
  try {
    const nodeConfig = readNodeJobsConfig(env)
    const run = createRunContext({
      runId: randomUUID(),
      deadlineAt: Date.now() + 600_000,
    })
    const db = createCloudflareD1Client(nodeConfig, run)
    const store = createR2Store(nodeConfig, run, 120_000)
    try {
      const result = await runBackupPipeline({
        run,
        db,
        store,
        leaseName: defaultBackupLeaseName(),
        leaseSeconds: defaultBackupLeaseSeconds(),
        stateDir: defaultBackupStateDir(),
        now: () => Date.now(),
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      })
      if (result.status === 'skipped') {
        return { job: 'airingcal-backup', status: 'skipped', message: result.stage }
      }
      return {
        job: 'airingcal-backup',
        status: 'success',
        message: `${result.stage}${result.bytes != null ? ` bytes=${result.bytes}` : ''}`,
      }
    } finally {
      store.close()
    }
  } catch (error) {
    if (isJobError(error)) {
      return { job: 'airingcal-backup', status: 'failed', message: error.code }
    }
    throw error
  }
}
