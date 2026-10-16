import type { PublicStore } from '@airing-cal/v3-core'
import { publishBuilderCheckpoint, type PublishCheckpointResult } from './publish-checkpoint.ts'
import { runBuilderSyncJob, type BuilderSyncJobDeps, type BuilderSyncJobResult } from './sync-job.ts'

export interface BuilderRunOnceDeps extends BuilderSyncJobDeps {
  publicStore: PublicStore
  manifestMetadata?: { source_observed_at: string; git_sha: string }
  publishAfterSync?: boolean
}

export interface BuilderRunOnceResult {
  sync: BuilderSyncJobResult
  publish: PublishCheckpointResult | null
}

export async function runBuilderOnce(deps: BuilderRunOnceDeps): Promise<BuilderRunOnceResult> {
  const sync = await runBuilderSyncJob(deps)
  if (!deps.publishAfterSync || sync.status === 'skipped' || sync.status === 'failed') {
    return { sync, publish: null }
  }
  if (sync.status === 'no_change') {
    const publish = await publishBuilderCheckpoint({
      state: deps.state,
      publicStore: deps.publicStore,
      manifestMetadata: deps.manifestMetadata,
    })
    return { sync, publish }
  }
  const publish = await publishBuilderCheckpoint({
    state: deps.state,
    publicStore: deps.publicStore,
    manifestMetadata: deps.manifestMetadata,
  })
  return { sync, publish }
}
