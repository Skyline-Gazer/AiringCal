import {
  buildManifest,
  canonicalSnapshotBytes,
  parsePublicSnapshotV1,
  snapshotObjectKey,
} from '@airing-cal/domain'
import { canonicalJson } from '@airing-cal/storage'
import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core'
import { BUILDER_SNAPSHOT_CHECKPOINT_KEY } from './sync-job.ts'
import type { SqliteBuilderStateStore } from './sqlite-state.ts'

export type PublishCheckpointStatus =
  | 'published'
  | 'no_checkpoint'
  | 'already_current'
  | 'readback_mismatch'
  | 'cas_conflict'
  | 'cas_unsupported'

export interface PublishCheckpointResult {
  status: PublishCheckpointStatus
  pointer: PublicReleasePointer | null
}

export interface PublishCheckpointDeps {
  state: SqliteBuilderStateStore
  publicStore: PublicStore
  schemaVersion?: number
  manifestMetadata?: { source_observed_at: string; git_sha: string }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
}

async function loadCheckpointSnapshot(state: SqliteBuilderStateStore) {
  const raw = await state.getKv(BUILDER_SNAPSHOT_CHECKPOINT_KEY)
  if (!raw) return null
  return parsePublicSnapshotV1(JSON.parse(raw))
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

  await deps.publicStore.putImmutableObject(artifactRef, bytes, 'application/json')
  const readback = await deps.publicStore.getSnapshotBytes(artifactRef)
  if (!readback || !bytesEqual(bytes, readback)) {
    return { status: 'readback_mismatch', pointer: null }
  }

  if (deps.manifestMetadata) {
    const manifest = buildManifest(snapshot, deps.manifestMetadata)
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifest))
    await deps.publicStore.putImmutableObject('public/manifest.json', manifestBytes, 'application/json')
    const manifestReadback = await deps.publicStore.getSnapshotBytes('public/manifest.json')
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
  }

  const commit = await deps.publicStore.commitRelease(expected, pointer)
  if (commit === 'unsupported') return { status: 'cas_unsupported', pointer: null }
  if (commit === 'conflict') return { status: 'cas_conflict', pointer: null }
  return { status: 'published', pointer }
}
