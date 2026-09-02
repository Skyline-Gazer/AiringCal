import {
  buildManifest,
  buildPublicSnapshot,
  canonicalSnapshotBytes,
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  snapshotKey,
  type PublicSnapshotInput,
} from '@airing-cal/domain'
import type {
  PendingPublicationInput,
  PublicationClaimInput,
  PublicationState,
  PublicationVerificationInput,
} from '../postgres/repositories.ts'
import type { S3Port } from './s3.ts'

export type SnapshotPublicationCandidate = {
  snapshot: PublicSnapshotInput
  runId: string
  observedAt: string
  gitSha: string
}

export type PublicationStatePort = {
  getState(): Promise<PublicationState>
  savePending(input: PendingPublicationInput): Promise<PublicationState>
  claimPending(input: PublicationClaimInput): Promise<PublicationState>
  verify(input: PublicationVerificationInput): Promise<PublicationState>
}

export type PublicationPort = { forMode(mode: 'live' | 'shadow'): PublicationStatePort }

export type PublicationPorts = { now(): string; s3: S3Port; publication: PublicationPort }

const manifestKey = (mode: 'live' | 'shadow') => mode === 'live' ? 'public/manifest.json' : 'shadow/manifest.json'
const namespacedSnapshotKey = (mode: 'live' | 'shadow', generation: number, contentHash: string) =>
  mode === 'live' ? snapshotKey(generation, contentHash) : `shadow/${snapshotKey(generation, contentHash)}`
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

export async function publishSnapshot(
  ports: PublicationPorts,
  candidate: SnapshotPublicationCandidate,
  mode: 'live' | 'shadow',
): Promise<'published' | 'no_change' | 'pending'> {
  const publication = ports.publication.forMode(mode)
  const initial = await publication.getState()
  const hashProbe = await buildPublicSnapshot(candidate.snapshot, initial.verifiedGeneration)
  if (initial.verifiedContentHash === hashProbe.content_hash) return 'no_change'

  const pendingMatches = initial.pendingGeneration !== null
    && initial.pendingContentHash === hashProbe.content_hash
    && initial.pendingObjectKey === namespacedSnapshotKey(mode, initial.pendingGeneration, hashProbe.content_hash)
  if (initial.pendingGeneration !== null && !pendingMatches) return 'pending'
  const generation = initial.pendingGeneration ?? initial.verifiedGeneration + 1
  const snapshot = await buildPublicSnapshot(candidate.snapshot, generation)
  const objectKey = namespacedSnapshotKey(mode, generation, snapshot.content_hash)
  const pending = pendingMatches ? initial : await publication.savePending({
    generation, contentHash: snapshot.content_hash, objectKey, runId: candidate.runId, createdAt: ports.now(),
  })
  const runId = pendingMatches ? initial.pendingRunId! : candidate.runId

  try {
    const bytes = canonicalSnapshotBytes(snapshot)
    await writeImmutableSnapshot(ports.s3, objectKey, bytes)
    const storedSnapshot = await readSnapshot(ports.s3, objectKey, bytes)
    const manifest = buildManifest(storedSnapshot, { source_observed_at: candidate.observedAt, git_sha: candidate.gitSha })
    const claimedAt = pending.pendingClaimedAt ?? ports.now()
    if (pending.pendingClaimedAt === null) await publication.claimPending({
      generation, contentHash: snapshot.content_hash, objectKey, runId, claimedAt,
    })
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    await ports.s3.put(manifestKey(mode), manifestBytes)
    await readManifest(ports.s3, manifestKey(mode), manifest)
    await publication.verify({ generation, contentHash: snapshot.content_hash, objectKey, runId,
      claimedAt, verifiedAt: ports.now() })
    return 'published'
  } catch (error) {
    if (error instanceof Error && error.message === 'SNAPSHOT_CONDITIONAL_CONFLICT') throw error
    return 'pending'
  }
}

async function writeImmutableSnapshot(s3: S3Port, key: string, bytes: Uint8Array): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await s3.put(key, bytes, { ifNoneMatch: true })
      return
    } catch (error) {
      if (statusCode(error) === 412) return
      if (statusCode(error) !== 409 || attempt === 1) {
        if (statusCode(error) === 409) throw new Error('SNAPSHOT_CONDITIONAL_CONFLICT')
        throw error
      }
    }
  }
}

async function readSnapshot(s3: S3Port, key: string, expectedBytes: Uint8Array) {
  const bytes = await s3.get(key)
  if (bytes === null || !sameBytes(bytes, expectedBytes)) throw new Error('SNAPSHOT_READBACK_INVALID')
  const snapshot = await parsePublicSnapshotV1(decode(bytes))
  if (snapshotKey(snapshot.generation, snapshot.content_hash) !== key.replace(/^shadow\//, '')) {
    throw new Error('SNAPSHOT_KEY_INVALID')
  }
  return snapshot
}

async function readManifest(s3: S3Port, key: string, expected: ReturnType<typeof buildManifest>): Promise<void> {
  const bytes = await s3.get(key)
  if (bytes === null) throw new Error('MANIFEST_READBACK_MISSING')
  const actual = parsePublicSnapshotManifestV1(decode(bytes))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('MANIFEST_READBACK_INVALID')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function statusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return null
  const metadata = error.$metadata
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) return null
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : null
}
