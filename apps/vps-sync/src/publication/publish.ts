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

export type PublicationPort = {
  getState(): Promise<PublicationState>
  savePending(input: PendingPublicationInput): Promise<PublicationState>
  claimPending(input: PublicationClaimInput): Promise<PublicationState>
  verify(input: PublicationVerificationInput): Promise<PublicationState>
}

export type PublicationPorts = { now(): string; s3: S3Port; publication: PublicationPort }

const manifestKey = (mode: 'live' | 'shadow') => mode === 'live' ? 'public/manifest.json' : 'shadow/manifest.json'
const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes))

export async function publishSnapshot(
  ports: PublicationPorts,
  candidate: SnapshotPublicationCandidate,
  mode: 'live' | 'shadow',
): Promise<'published' | 'no_change' | 'pending'> {
  const initial = await ports.publication.getState()
  const hashProbe = await buildPublicSnapshot(candidate.snapshot, initial.verifiedGeneration)
  if (initial.verifiedContentHash === hashProbe.content_hash) return 'no_change'

  const pendingMatches = initial.pendingGeneration !== null
    && initial.pendingContentHash === hashProbe.content_hash
    && initial.pendingRunId === candidate.runId
  if (initial.pendingGeneration !== null && !pendingMatches) return 'pending'
  const generation = initial.pendingGeneration ?? initial.verifiedGeneration + 1
  const snapshot = await buildPublicSnapshot(candidate.snapshot, generation)
  const objectKey = snapshotKey(generation, snapshot.content_hash)
  const pending = pendingMatches ? initial : await ports.publication.savePending({
    generation, contentHash: snapshot.content_hash, objectKey, runId: candidate.runId, createdAt: ports.now(),
  })

  try {
    const bytes = canonicalSnapshotBytes(snapshot)
    await ports.s3.put(objectKey, bytes, { ifNoneMatch: true })
    const storedSnapshot = await readSnapshot(ports.s3, objectKey, bytes)
    const manifest = buildManifest(storedSnapshot, { source_observed_at: candidate.observedAt, git_sha: candidate.gitSha })
    const claimedAt = pending.pendingClaimedAt ?? ports.now()
    if (pending.pendingClaimedAt === null) await ports.publication.claimPending({
      generation, contentHash: snapshot.content_hash, objectKey, runId: candidate.runId, claimedAt,
    })
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest))
    await ports.s3.put(manifestKey(mode), manifestBytes)
    await readManifest(ports.s3, manifestKey(mode), manifest)
    await ports.publication.verify({ generation, contentHash: snapshot.content_hash, objectKey, runId: candidate.runId,
      claimedAt, verifiedAt: ports.now() })
    return 'published'
  } catch {
    return 'pending'
  }
}

async function readSnapshot(s3: S3Port, key: string, expectedBytes: Uint8Array) {
  const bytes = await s3.get(key)
  if (bytes === null || !sameBytes(bytes, expectedBytes)) throw new Error('SNAPSHOT_READBACK_INVALID')
  return parsePublicSnapshotV1(decode(bytes))
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
