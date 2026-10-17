import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import { buildPublicSnapshot, parsePublicSnapshotV1 } from '@airing-cal/domain'
import { canonicalJson } from '@airing-cal/storage'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import { mediaPublishHintsFromFetch, nextSnapshotGeneration, projectPublicSnapshotInput } from '@airing-cal/v3-core'
import type { SqliteBuilderStateStore } from './sqlite-state.ts'
import type { SyncRunMode } from './sync-runs.ts'
import { SyncRunStore } from './sync-runs.ts'

export const BUILDER_SYNC_LEASE_JOB_ID = 'builder-sync'
export const BUILDER_SNAPSHOT_CHECKPOINT_KEY = 'checkpoint:public-snapshot'

export type BuilderSyncJobStatus = 'skipped' | 'no_change' | 'ok' | 'failed'

export interface BuilderSyncJobResult {
  status: BuilderSyncJobStatus
  generation: number | null
  run_id: string
}

export interface BuilderSyncJobDeps {
  state: SqliteBuilderStateStore
  runs: SyncRunStore
  runId: string
  mode: SyncRunMode
  ownerToken: string
  leaseSeconds?: number
  fetchInput(): Promise<CompleteFullFetch>
  now(): number
  /** When true, derive `image_status` from Bangumi URLs without a cached image map (portable builder). */
  projectFetchMediaHints?: boolean
}

async function loadCheckpointSnapshot(state: SqliteBuilderStateStore): Promise<PublicSnapshotV1 | null> {
  const raw = await state.getKv(BUILDER_SNAPSHOT_CHECKPOINT_KEY)
  if (!raw) return null
  return parsePublicSnapshotV1(JSON.parse(raw))
}

export async function runBuilderSyncJob(deps: BuilderSyncJobDeps): Promise<BuilderSyncJobResult> {
  const leaseSeconds = deps.leaseSeconds ?? 1800
  const nowUnix = Math.floor(deps.now() / 1000)
  const acquired = await deps.state.acquireLease(BUILDER_SYNC_LEASE_JOB_ID, deps.ownerToken, leaseSeconds, nowUnix)
  if (!acquired) {
    return { status: 'skipped', generation: null, run_id: deps.runId }
  }

  deps.runs.startRun(deps.runId, deps.mode, nowUnix)
  try {
    const input = await deps.fetchInput()
    const previous = await loadCheckpointSnapshot(deps.state)
    const mediaHints = deps.projectFetchMediaHints ? mediaPublishHintsFromFetch(input) : new Map()
    const candidateInput = projectPublicSnapshotInput(input, new Map(), new Map(), new Map(), mediaHints)
    const probe = await buildPublicSnapshot(candidateInput, 0)
    const generation = nextSnapshotGeneration(previous, probe.content_hash)
    if (generation === null) {
      deps.runs.finishRun(deps.runId, 'succeeded', canonicalJson({ stage: 'no_change' }), nowUnix)
      return { status: 'no_change', generation: previous?.generation ?? null, run_id: deps.runId }
    }

    const snapshot = await buildPublicSnapshot(candidateInput, generation)
    await parsePublicSnapshotV1(snapshot)
    await deps.state.setKv(BUILDER_SNAPSHOT_CHECKPOINT_KEY, canonicalJson(snapshot), nowUnix)
    deps.runs.finishRun(
      deps.runId,
      'succeeded',
      canonicalJson({ stage: 'checkpoint', generation: snapshot.generation, content_hash: snapshot.content_hash }),
      nowUnix,
    )
    return { status: 'ok', generation: snapshot.generation, run_id: deps.runId }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown'
    deps.runs.finishRun(deps.runId, 'failed', canonicalJson({ error: detail }), Math.floor(deps.now() / 1000))
    return { status: 'failed', generation: null, run_id: deps.runId }
  } finally {
    await deps.state.releaseLease(BUILDER_SYNC_LEASE_JOB_ID, deps.ownerToken)
  }
}
