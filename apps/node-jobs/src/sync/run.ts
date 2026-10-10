import { randomUUID } from 'node:crypto'
import {
  createCloudflareD1Client,
  createR2Store,
  createRunContext,
  readNodeJobsConfig,
} from '../adapters/index.ts'
import type { JobSummary } from '../contracts.ts'
import { createUpstreamBgmClient, fetchCompleteInput } from '../upstream/fetch.ts'
import { readSyncUserConfig } from './config.ts'
import { noopMediaRefresh } from './media-port.ts'
import { defaultLeaseName, defaultLeaseSeconds, runSyncPipeline } from './pipeline.ts'

/** Full pipeline: lease → fetch → media → publish (AC-1-03). */
export async function runSync(env: Record<string, string | undefined> = process.env): Promise<JobSummary> {
  if (!env.AIRINGCAL_USERS_JSON?.trim()) {
    return {
      job: 'airingcal-sync',
      status: 'skipped',
      message: 'AIRINGCAL_USERS_JSON not configured',
    }
  }
  const nodeConfig = readNodeJobsConfig(env)
  const syncConfig = readSyncUserConfig(env)
  const run = createRunContext({
    runId: randomUUID(),
    deadlineAt: Date.now() + 1_500_000,
  })
  const db = createCloudflareD1Client(nodeConfig, run)
  const store = createR2Store(nodeConfig, run)
  try {
    const client = createUpstreamBgmClient(env.BGM_TOKEN?.trim())
    const result = await runSyncPipeline({
      run,
      db,
      store,
      syncConfig,
      leaseName: defaultLeaseName(),
      leaseSeconds: defaultLeaseSeconds(),
      fetchInput: () => fetchCompleteInput(
        { users: syncConfig.users, primaryUserId: syncConfig.primaryUserId },
        client,
        () => Date.now(),
      ),
      media: noopMediaRefresh,
      now: () => Date.now(),
    })
    return {
      job: 'airingcal-sync',
      status: result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : 'success',
      message: `${result.stage}${result.generation != null ? ` generation=${result.generation}` : ''}`,
    }
  } finally {
    store.close()
  }
}
