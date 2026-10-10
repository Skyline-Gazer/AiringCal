import {
  buildManifest,
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  snapshotObjectKey,
} from '@airing-cal/domain'
import { canonicalJson } from '@airing-cal/storage'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import { fail, isJobError } from '../adapters/errors.ts'
import type { JobLease } from '../adapters/job-lease.ts'
import { acquireJobLease } from '../adapters/job-lease.ts'
import type { R2Store } from '../adapters/r2-store.ts'
import type { RunContext } from '../adapters/run-context.ts'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { SyncUserConfig } from './config.ts'
import type { MediaRefreshPort } from './media-port.ts'
import { nextSnapshotGeneration } from './publish-helpers.ts'
import { projectPublicSnapshotInput } from './project-public.ts'

export type SyncRunStatus = 'skipped' | 'ok' | 'no_change' | 'failed'

export interface SyncPipelineResult {
  status: SyncRunStatus
  stage: string
  generation: number | null
}

export interface SyncPipelineDeps {
  run: RunContext
  db: CloudflareD1Client
  store: R2Store
  syncConfig: SyncUserConfig
  leaseName: string
  leaseSeconds: number
  fetchInput(): Promise<CompleteFullFetch>
  media: MediaRefreshPort
  now(): number
}

const LEASE_NAME = 'airingcal-data-plane'
const LEASE_SECONDS = 1800

async function loadPreviousSnapshot(store: R2Store) {
  const manifestBytes = await store.get('public/manifest.json')
  if (!manifestBytes) return { previous: null, manifestEtag: null as string | null }
  const manifest = parsePublicSnapshotManifestV1(JSON.parse(new TextDecoder().decode(manifestBytes)))
  const snapshotBytes = await store.get(manifest.snapshot_key)
  if (!snapshotBytes) fail('REQUEST_FAILED')
  const previous = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(snapshotBytes)))
  return { previous, manifestEtag: null }
}

export async function runSyncPipeline(deps: SyncPipelineDeps): Promise<SyncPipelineResult> {
  let lease: JobLease | null = null
  try {
    lease = await acquireJobLease(deps.db, deps.run, deps.leaseName, deps.leaseSeconds)
    if (!lease) {
      return { status: 'skipped', stage: 'lease_busy', generation: null }
    }
    const startedAt = Math.floor(deps.now() / 1000)
    await deps.db.query(
      'INSERT INTO airingcal_job_runs (id, started_at, status) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING',
      [deps.run.owner, startedAt, 'running'],
    )

    const input = await deps.fetchInput()
    const chunks: unknown[] = []
    for (let offset = 0; offset < input.collections.length; offset += 50) {
      chunks.push({ collections: input.collections.slice(offset, offset + 50) })
    }
    for (const day of input.calendar) chunks.push({ calendar: [day] })
    for (let index = 0; index < chunks.length; index++) {
      await lease.guard()
      await deps.db.query(
        'INSERT INTO airingcal_job_inputs (run_id, chunk, payload) VALUES (?, ?, ?) ON CONFLICT(run_id, chunk) DO UPDATE SET payload=excluded.payload',
        [deps.run.owner, index, canonicalJson(chunks[index])],
      )
    }
    await deps.db.query('UPDATE airingcal_job_runs SET observed_at=? WHERE id=?', [input.observedAt, deps.run.owner])

    const mediaContext = { ...deps.run, observedAt: new Date(input.observedAt * 1000).toISOString() }
    await lease.guard()
    await deps.media.refresh(mediaContext)

    const { previous } = await loadPreviousSnapshot(deps.store)
    const candidateInput = projectPublicSnapshotInput(input)
    const candidate = await buildPublicSnapshot(candidateInput, 0)
    const generation = nextSnapshotGeneration(previous, candidate.content_hash)
    let published = previous
    if (generation !== null) {
      const snapshot = await buildPublicSnapshot(candidateInput, generation)
      await parsePublicSnapshotV1(snapshot)
      const key = snapshotObjectKey(snapshot)
      const bytes = canonicalSnapshotBytes(snapshot)
      if (bytes.byteLength > 32 * 1024 * 1024) fail('REQUEST_FAILED')
      await lease.guard()
      await deps.store.verifiedPut(key, bytes, 'application/json')
      const readback = await deps.store.get(key, bytes.byteLength)
      if (!readback) fail('R2_READBACK_MISMATCH')
      published = await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(readback)))
    }

    const manifest = buildManifest(published!, {
      source_observed_at: new Date(input.observedAt * 1000).toISOString(),
      git_sha: deps.syncConfig.gitSha,
    })
    await lease.guard()
    await deps.store.verifiedPut('public/manifest.json', new TextEncoder().encode(canonicalJson(manifest)), 'application/json')

    const completedAt = Math.floor(deps.now() / 1000)
    await deps.db.query(
      'UPDATE airingcal_job_runs SET completed_at=?, status=?, generation=? WHERE id=?',
      [completedAt, 'ok', published!.generation, deps.run.owner],
    )
    await deps.db.query('DELETE FROM airingcal_job_inputs WHERE run_id<>?', [deps.run.owner])

    return {
      status: generation === null ? 'no_change' : 'ok',
      stage: generation === null ? 'no_change' : 'complete',
      generation: published!.generation,
    }
  } catch (error) {
    if (isJobError(error)) throw error
    throw fail('REQUEST_FAILED', undefined, { cause: error })
  } finally {
    if (lease) await lease.release().catch(() => undefined)
  }
}

export function defaultLeaseName(): string {
  return LEASE_NAME
}

export function defaultLeaseSeconds(): number {
  return LEASE_SECONDS
}
