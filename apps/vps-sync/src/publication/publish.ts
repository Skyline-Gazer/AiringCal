import {
  buildManifest,
  canonicalSnapshotBytes,
  nextSnapshotGeneration,
  parsePublicSnapshotManifestV1,
  parsePublicSnapshotV1,
  snapshotKey,
} from '@airing-cal/domain'
import { canonicalJson, type PublicSnapshotV1 } from '@airing-cal/storage'
import type { PostgresAuthority, Publication } from '../postgres/repositories.js'
import type { S3Port } from './s3.js'

export interface PublicationCandidate {
  snapshot: PublicSnapshotV1
  runId: string
  observedAt: number
  gitSha: string
}

type PublicationAuthority = Pick<PostgresAuthority, 'getPublicationState' | 'savePendingPublication' | 'verifyPublication'>

export interface PublicationPorts {
  authority: PublicationAuthority
  s3: S3Port
}

export type PublicationMode = 'live' | 'shadow'
export type PublicationResult = 'published' | 'no_change' | 'pending'

const LIVE_MANIFEST_KEY = 'public/manifest.json'
const SHADOW_MANIFEST_KEY = 'shadow/manifest.json'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value))
}

function candidatePublication(snapshot: PublicSnapshotV1, candidate: PublicationCandidate, generation: number): Publication {
  return {
    generation,
    content_hash: snapshot.content_hash,
    object_key: snapshotKey(generation, snapshot.content_hash),
    published_at: snapshot.published_at,
    observed_at: candidate.observedAt,
    run_id: candidate.runId,
    item_count: snapshot.summary._total,
    git_sha: candidate.gitSha,
  }
}

function samePublication(left: Publication | null, right: Publication): boolean {
  return left !== null
    && left.generation === right.generation
    && left.content_hash === right.content_hash
    && left.object_key === right.object_key
    && left.published_at === right.published_at
    && left.observed_at === right.observed_at
    && left.run_id === right.run_id
    && left.item_count === right.item_count
    && left.git_sha === right.git_sha
}

function sameOptionalPublication(left: Publication | null, right: Publication | null): boolean {
  return left === null ? right === null : right !== null && samePublication(left, right)
}

function publicationManifestMatches(bytes: Uint8Array | null, verified: Publication | null): boolean {
  if (!verified) return bytes === null
  if (!bytes) return false
  try {
    const manifest = parsePublicSnapshotManifestV1(parseJson(bytes))
    return manifest.generation === verified.generation
      && manifest.snapshot_key === verified.object_key
      && manifest.content_sha256 === verified.content_hash
      && manifest.published_at === new Date(verified.published_at * 1_000).toISOString()
      && manifest.source_observed_at === new Date(verified.observed_at * 1_000).toISOString()
      && manifest.item_count === verified.item_count
      && manifest.git_sha === verified.git_sha
  } catch {
    return false
  }
}

async function restoreManifest(s3: S3Port, key: string, previous: Uint8Array | null): Promise<void> {
  if (previous === null) await s3.delete(key)
  else await s3.put(key, previous)
  const restored = await s3.get(key)
  if (previous === null ? restored !== null : restored === null || !sameBytes(restored, previous)) {
    throw new Error('PUBLICATION_ROLLBACK_FAILED')
  }
}

async function prepareSnapshot(snapshot: PublicSnapshotV1, publication: Publication): Promise<PublicSnapshotV1> {
  return parsePublicSnapshotV1({ ...snapshot, generation: publication.generation, published_at: publication.published_at })
}

function buildPublicationManifest(snapshot: PublicSnapshotV1, publication: Publication) {
  return buildManifest(snapshot, { source_observed_at: publication.observed_at, git_sha: publication.git_sha })
}

async function verifySnapshotObject(s3: S3Port, snapshot: PublicSnapshotV1, publication: Publication): Promise<void> {
  const expected = canonicalSnapshotBytes(snapshot)
  const readback = await s3.get(publication.object_key)
  if (!readback || !sameBytes(readback, expected)) throw new Error('SNAPSHOT_READBACK_MISMATCH')
  const parsed = await parsePublicSnapshotV1(parseJson(readback))
  if (parsed.generation !== publication.generation || parsed.published_at !== publication.published_at) {
    throw new Error('SNAPSHOT_READBACK_MISMATCH')
  }
}

async function verifiedManifestBytes(s3: S3Port, verified: Publication | null): Promise<Uint8Array | null> {
  if (!verified) return null
  const snapshotBytes = await s3.get(verified.object_key)
  if (!snapshotBytes) throw new Error('VERIFIED_SNAPSHOT_MISSING')
  const snapshot = await parsePublicSnapshotV1(parseJson(snapshotBytes))
  if (!sameBytes(snapshotBytes, canonicalSnapshotBytes(snapshot))
    || snapshot.generation !== verified.generation
    || snapshot.content_hash !== verified.content_hash
    || snapshot.published_at !== verified.published_at) {
    throw new Error('VERIFIED_SNAPSHOT_MISMATCH')
  }
  const bytes = canonicalBytes(buildPublicationManifest(snapshot, verified))
  if (!publicationManifestMatches(bytes, verified)) throw new Error('VERIFIED_MANIFEST_MISMATCH')
  return bytes
}

async function publishLive(
  ports: PublicationPorts,
  candidate: PublicationCandidate,
  snapshot: PublicSnapshotV1,
): Promise<PublicationResult> {
  const state = await ports.authority.getPublicationState()
  const nextGeneration = nextSnapshotGeneration(state.verified, snapshot.content_hash)
  if (nextGeneration === null && state.verified) {
    const unchanged = {
      ...state.verified,
      run_id: candidate.runId,
      observed_at: candidate.observedAt,
      item_count: snapshot.summary._total,
      git_sha: candidate.gitSha,
    }
    await ports.authority.savePendingPublication(unchanged, 'keep')
    return 'no_change'
  }

  if (state.claimed && (!state.pending || state.pending.content_hash !== snapshot.content_hash)) return 'pending'
  const proposed = state.claimed && state.pending
    ? state.pending
    : candidatePublication(snapshot, candidate, nextGeneration ?? 1)

  let pending: Awaited<ReturnType<PublicationAuthority['savePendingPublication']>>
  try {
    pending = await ports.authority.savePendingPublication(proposed, 'claim')
  } catch (error) {
    const latest = await ports.authority.getPublicationState()
    if (latest.verified?.content_hash === snapshot.content_hash) return 'no_change'
    if (latest.claimed) return 'pending'
    throw error
  }
  if (pending.outcome === 'no_change') return 'no_change'

  const publication = pending.publication
  const finalSnapshot = await prepareSnapshot(snapshot, publication)
  const finalManifest = buildPublicationManifest(finalSnapshot, publication)
  const finalManifestBytes = canonicalBytes(finalManifest)
  let previousManifest: Uint8Array | null
  try {
    previousManifest = await ports.s3.get(LIVE_MANIFEST_KEY)
  } catch {
    return 'pending'
  }
  if (!publicationManifestMatches(previousManifest, state.verified)) {
    const candidateManifestIsVisible = previousManifest !== null
      && sameBytes(previousManifest, finalManifestBytes)
      && publicationManifestMatches(previousManifest, publication)
    if (candidateManifestIsVisible) {
      let candidateSnapshotIsValid = false
      try {
        await verifySnapshotObject(ports.s3, finalSnapshot, publication)
        candidateSnapshotIsValid = true
      } catch {
        // Do not promote a candidate whose immutable snapshot did not verify.
      }
      if (candidateSnapshotIsValid) {
        try {
          await ports.authority.verifyPublication(publication)
          return 'published'
        } catch {
          let latest: Awaited<ReturnType<PublicationAuthority['getPublicationState']>>
          try {
            latest = await ports.authority.getPublicationState()
          } catch {
            // Keep the validated candidate pointer until a later replay resolves the commit outcome.
            return 'pending'
          }
          if (samePublication(latest.verified, publication)) return 'published'
          if (!sameOptionalPublication(latest.verified, state.verified)
            || !latest.claimed
            || !samePublication(latest.pending, publication)) return 'pending'
        }
      }
    }
    try {
      await restoreManifest(ports.s3, LIVE_MANIFEST_KEY, await verifiedManifestBytes(ports.s3, state.verified))
    } catch (rollbackError) {
      throw new AggregateError([new Error('MANIFEST_READBACK_MISMATCH'), rollbackError], 'PUBLICATION_ROLLBACK_FAILED')
    }
    return 'pending'
  }

  let manifestWriteAttempted = false
  let verificationAttempted = false
  try {
    const objectKey = publication.object_key
    const snapshotBytes = canonicalSnapshotBytes(finalSnapshot)
    await ports.s3.put(objectKey, snapshotBytes, { ifNoneMatch: '*' })
    await verifySnapshotObject(ports.s3, finalSnapshot, publication)

    manifestWriteAttempted = true
    await ports.s3.put(LIVE_MANIFEST_KEY, finalManifestBytes)
    const manifestReadback = await ports.s3.get(LIVE_MANIFEST_KEY)
    if (!manifestReadback || !sameBytes(manifestReadback, finalManifestBytes)) throw new Error('MANIFEST_READBACK_MISMATCH')
    const parsedManifest = parsePublicSnapshotManifestV1(parseJson(manifestReadback))
    if (canonicalJson(parsedManifest) !== canonicalJson(finalManifest)) throw new Error('MANIFEST_READBACK_MISMATCH')

    verificationAttempted = true
    await ports.authority.verifyPublication(publication)
    return 'published'
  } catch (error) {
    if (verificationAttempted) {
      let latest: Awaited<ReturnType<PublicationAuthority['getPublicationState']>>
      try {
        latest = await ports.authority.getPublicationState()
      } catch {
        // Keep the validated candidate pointer until a later replay resolves the commit outcome.
        return 'pending'
      }
      if (samePublication(latest.verified, publication)) return 'published'
      if (!sameOptionalPublication(latest.verified, state.verified)
        || !latest.claimed
        || !samePublication(latest.pending, publication)) return 'pending'
    }
    if (manifestWriteAttempted) {
      try {
        await restoreManifest(ports.s3, LIVE_MANIFEST_KEY, previousManifest)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'PUBLICATION_ROLLBACK_FAILED')
      }
    }
    return 'pending'
  }
}

async function publishShadow(
  ports: PublicationPorts,
  candidate: PublicationCandidate,
  snapshot: PublicSnapshotV1,
): Promise<PublicationResult> {
  let previousManifest: Uint8Array | null
  try {
    previousManifest = await ports.s3.get(SHADOW_MANIFEST_KEY)
  } catch {
    return 'pending'
  }
  let previous: ReturnType<typeof parsePublicSnapshotManifestV1> | null = null
  if (previousManifest) {
    try {
      previous = parsePublicSnapshotManifestV1(parseJson(previousManifest))
    } catch {
      previous = null
    }
  }
  if (previous?.content_sha256 === snapshot.content_hash) return 'no_change'

  const generation = nextSnapshotGeneration(
    previous ? { generation: previous.generation, content_hash: previous.content_sha256 } : null,
    snapshot.content_hash,
  ) ?? 1
  const proposed = candidatePublication(snapshot, candidate, generation)
  const publishedSnapshot = await prepareSnapshot(snapshot, proposed)
  const manifest = buildPublicationManifest(publishedSnapshot, proposed)
  const manifestBytes = canonicalBytes(manifest)
  const objectKey = `shadow/${proposed.object_key}`
  let manifestWriteAttempted = false
  try {
    const snapshotBytes = canonicalSnapshotBytes(publishedSnapshot)
    await ports.s3.put(objectKey, snapshotBytes, { ifNoneMatch: '*' })
    const snapshotReadback = await ports.s3.get(objectKey)
    if (!snapshotReadback || !sameBytes(snapshotReadback, snapshotBytes)) throw new Error('SNAPSHOT_READBACK_MISMATCH')
    const parsedSnapshot = await parsePublicSnapshotV1(parseJson(snapshotReadback))
    if (parsedSnapshot.generation !== generation || parsedSnapshot.published_at !== proposed.published_at) {
      throw new Error('SNAPSHOT_READBACK_MISMATCH')
    }

    manifestWriteAttempted = true
    await ports.s3.put(SHADOW_MANIFEST_KEY, manifestBytes)
    const manifestReadback = await ports.s3.get(SHADOW_MANIFEST_KEY)
    if (!manifestReadback || !sameBytes(manifestReadback, manifestBytes)) throw new Error('MANIFEST_READBACK_MISMATCH')
    const parsedManifest = parsePublicSnapshotManifestV1(parseJson(manifestReadback))
    if (canonicalJson(parsedManifest) !== canonicalJson(manifest)) throw new Error('MANIFEST_READBACK_MISMATCH')
    return 'published'
  } catch (error) {
    if (manifestWriteAttempted) {
      try {
        await restoreManifest(ports.s3, SHADOW_MANIFEST_KEY, previousManifest)
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'PUBLICATION_ROLLBACK_FAILED')
      }
    }
    return 'pending'
  }
}

export async function publishSnapshot(
  ports: PublicationPorts,
  candidate: PublicationCandidate,
  mode: PublicationMode,
): Promise<PublicationResult> {
  const snapshot = await parsePublicSnapshotV1(candidate.snapshot)
  if (mode === 'shadow') return publishShadow(ports, candidate, snapshot)
  return publishLive(ports, candidate, snapshot)
}
