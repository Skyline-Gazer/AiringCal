import { randomUUID } from 'node:crypto'
import {
  createCloudflareD1Client,
  createCloudflareKvClient,
  createR2Store,
  createRunContext,
  readNodeJobsConfig,
} from '../adapters/index.ts'
import type { JobSummary } from '../contracts.ts'
import { subjectDetailImages } from '@airing-cal/domain'
import { createUpstreamBgmClient, fetchCompleteInput } from '../upstream/fetch.ts'
import { readSyncUserConfig } from './config.ts'
import { countAccountLargeImages, createSubjectMediaRefresh } from './media-refresh.ts'
import { createEnrichMediaSubjectsFromFetch } from './media-subject-resolve.ts'
import { defaultLeaseName, defaultLeaseSeconds, runSyncPipeline } from './pipeline.ts'
import { runPortableBuilderSync } from './run-portable.ts'
import { fireAndForgetThumbGen, logThumbGenSyncTail } from './thumb-gen-client.ts'

function isPortableBuilder(env: Record<string, string | undefined>): boolean {
  return (env.AIRINGCAL_BUILDER?.trim().toLowerCase() ?? '') === 'portable'
}

/** Full pipeline: lease → fetch → media → publish (AC-1-03). */
export async function runSync(env: Record<string, string | undefined> = process.env): Promise<JobSummary> {
  if (isPortableBuilder(env)) {
    return runPortableBuilderSync(env)
  }
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
  const imageStore = nodeConfig.imageBucket === nodeConfig.r2Bucket
    ? store
    : createR2Store({ ...nodeConfig, r2Bucket: nodeConfig.imageBucket }, run)
  const kv = nodeConfig.kvNamespaceId ? createCloudflareKvClient(nodeConfig, run) : null
  try {
    const client = createUpstreamBgmClient(env.BGM_TOKEN?.trim())
    const resolveMediaSubjects = createEnrichMediaSubjectsFromFetch(async (subjectId) => {
      const subject = await client.getSubject(subjectId)
      return subject ? subjectDetailImages(subject) : null
    })
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
      resolveMediaSubjects,
      media: createSubjectMediaRefresh({ db, store: imageStore }),
      kv,
      now: () => Date.now(),
    })
    const failIds = result.media.failures.map((entry) => entry.subject_id).join(',')
    const media = `media selected=${result.media.selected} succeeded=${result.media.succeeded} failed=${result.media.failed}${failIds ? ` failed_subject_ids=${failIds}` : ''}`
    console.log(media)
    if (result.media.failures.length > 0) {
      console.log(JSON.stringify({ status: 'info', stage: 'media_failures', failures: result.media.failures }))
    }
    fireAndForgetThumbGen(result.media.large_hashes_persisted, env)
    const accountLargeCount = await countAccountLargeImages(db)
    logThumbGenSyncTail({
      env,
      large_persisted_this_run: result.media.large_hashes_persisted.length,
      account_large_count: accountLargeCount,
    })
    return {
      job: 'airingcal-sync',
      status: result.status === 'failed' ? 'failed' : result.status === 'skipped' ? 'skipped' : 'success',
      message: `${result.stage}${result.generation != null ? ` generation=${result.generation}` : ''} ${media}`,
    }
  } finally {
    if (imageStore !== store) imageStore.close()
    store.close()
  }
}
