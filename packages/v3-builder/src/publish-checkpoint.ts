import {
  buildManifest,
  canonicalSnapshotBytes,
  manifestObjectKey,
  parsePublicSnapshotV1,
  snapshotObjectKey,
  type PublicSnapshotManifestMetadata,
} from '@airing-cal/domain'
import { canonicalJson, sha256Canonical } from '@airing-cal/storage'
import type { PublicSnapshotV1 } from '@airing-cal/storage'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import { bytesEqual } from '@airing-cal/v3-core/public-pointer'
import { BUILDER_SNAPSHOT_CHECKPOINT_KEY } from './sync-job.ts'
import type { SqliteBuilderStateStore } from './sqlite-state.ts'

export type PublishCheckpointStatus =
  | 'published'
  | 'no_checkpoint'
  | 'already_current'
  | 'readback_mismatch'
  | 'pre_publish_failed'
  | 'cas_conflict'
  | 'cas_unsupported'

export interface PublishCheckpointResult {
  status: PublishCheckpointStatus
  pointer: PublicReleasePointer | null
  /** Detail when the publish aborted before or during the commit sequence. */
  error?: string
}

export interface PublishCheckpointDeps {
  state: SqliteBuilderStateStore
  publicStore: PublicStore
  schemaVersion?: number
  manifestMetadata?: { source_observed_at: string; git_sha: string }
  /**
   * Publish gate (C2): runs after the Snapshot is materialized and before any pointer commit.
   * Throwing aborts the publish with `pre_publish_failed` and leaves the pointer untouched.
   */
  prePublish?: (snapshot: PublicSnapshotV1) => Promise<void>
}

/**
 * Builder KV key holding `{ "<generation>:<content_hash>": { source_observed_at, git_sha } }`.
 * Manifest metadata is persisted at first materialization and reused on retries so the same
 * Snapshot always produces byte-identical manifests at the same immutable object key (C1).
 */
export const BUILDER_MANIFEST_METADATA_KEY = 'checkpoint:public-manifest-metadata'

async function loadCheckpointSnapshot(state: SqliteBuilderStateStore) {
  const raw = await state.getKv(BUILDER_SNAPSHOT_CHECKPOINT_KEY)
  if (!raw) return null
  return parsePublicSnapshotV1(JSON.parse(raw))
}

async function resolveManifestMetadata(
  state: SqliteBuilderStateStore,
  incoming: { source_observed_at: string; git_sha: string } | undefined,
  snapshot: PublicSnapshotV1,
): Promise<PublicSnapshotManifestMetadata | null> {
  const raw = await state.getKv(BUILDER_MANIFEST_METADATA_KEY)
  const stored: Record<string, PublicSnapshotManifestMetadata> = raw ? JSON.parse(raw) : {}
  const identity = `${snapshot.generation}:${snapshot.content_hash}`
  const existing = stored[identity]
  if (existing) return existing
  if (!incoming) return null
  stored[identity] = incoming
  await state.setKv(BUILDER_MANIFEST_METADATA_KEY, canonicalJson(stored))
  return incoming
}

export async function publishBuilderCheckpoint(deps: PublishCheckpointDeps): Promise<PublishCheckpointResult> {
  const snapshot = await loadCheckpointSnapshot(deps.state)
  if (!snapshot) return { status: 'no_checkpoint', pointer: null }

  const artifactRef = snapshotObjectKey(snapshot)
  const bytes = canonicalSnapshotBytes(snapshot)
  await parsePublicSnapshotV1(JSON.parse(new TextDecoder().decode(bytes)))

  const expected = await deps.publicStore.getCurrentRelease()
  if (
    expected?.content_hash === snapshot.content_hash
    && expected.generation === snapshot.generation
    && expected.artifact_ref === artifactRef
  ) {
    return { status: 'already_current', pointer: expected }
  }

  try {
    await deps.prePublish?.(snapshot)
  } catch (error) {
    return {
      status: 'pre_publish_failed',
      pointer: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const metadata = await resolveManifestMetadata(deps.state, deps.manifestMetadata, snapshot)

  await deps.publicStore.putImmutableObject(artifactRef, bytes, 'application/json')
  const readback = await deps.publicStore.getSnapshotBytes(artifactRef)
  if (!readback || !bytesEqual(bytes, readback)) {
    return { status: 'readback_mismatch', pointer: null }
  }

  let manifestRef: string | undefined
  if (metadata) {
    const manifest = buildManifest(snapshot, metadata)
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
    manifestRef = manifestObjectKey(snapshot.generation, await sha256Canonical(manifest))
    await deps.publicStore.putImmutableObject(manifestRef, manifestBytes, 'application/json')
    const manifestReadback = await deps.publicStore.getSnapshotBytes(manifestRef)
    if (!manifestReadback || !bytesEqual(manifestBytes, manifestReadback)) {
      return { status: 'readback_mismatch', pointer: null }
    }
  }

  const pointer: PublicReleasePointer = {
    schema_version: deps.schemaVersion ?? 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    published_at_unix: snapshot.published_at,
    artifact_ref: artifactRef,
    ...(manifestRef ? { manifest_ref: manifestRef } : {}),
  }

  const commit = await deps.publicStore.commitRelease(expected, pointer)
  if (commit === 'unsupported') return { status: 'cas_unsupported', pointer: null }
  if (commit === 'conflict') return { status: 'cas_conflict', pointer: null }
  return { status: 'published', pointer }
}
