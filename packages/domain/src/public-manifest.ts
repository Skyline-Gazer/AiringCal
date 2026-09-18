import { canonicalJson, type PublicSnapshotV1 } from '@airing-cal/storage'
import { snapshotKey } from './public-snapshot.ts'

export interface PublicSnapshotManifestV1 {
  schema_version: 1
  generation: number
  snapshot_key: string
  content_sha256: string
  published_at: string
  source_observed_at: string
  item_count: number
  git_sha: string
}

export interface PublicSnapshotManifestMetadata {
  source_observed_at: number
  git_sha: string
}

export { snapshotKey }

const MANIFEST_KEYS = [
  'schema_version',
  'generation',
  'snapshot_key',
  'content_sha256',
  'published_at',
  'source_observed_at',
  'item_count',
  'git_sha',
] as const
const LOWERCASE_GIT_SHA = /^[0-9a-f]{40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isUtcIso8601(value: unknown): value is string {
  if (typeof value !== 'string' || !value.endsWith('Z')) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function toUtcIso8601(seconds: number, field: string): string {
  if (!isNonNegativeInteger(seconds)) throw new Error(`Invalid manifest ${field}`)
  const date = new Date(seconds * 1_000)
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid manifest ${field}`)
  return date.toISOString()
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === MANIFEST_KEYS.length
    && MANIFEST_KEYS.every((key) => Object.hasOwn(value, key))
}

function isPublicSnapshotManifestV1(value: unknown): value is PublicSnapshotManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value) || value.schema_version !== 1) return false
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.item_count)) return false
  if (typeof value.content_sha256 !== 'string' || typeof value.snapshot_key !== 'string') return false
  let expectedKey: string
  try {
    expectedKey = snapshotKey(value.generation, value.content_sha256)
  } catch {
    return false
  }
  return value.snapshot_key === expectedKey
    && isUtcIso8601(value.published_at)
    && isUtcIso8601(value.source_observed_at)
    && typeof value.git_sha === 'string'
    && LOWERCASE_GIT_SHA.test(value.git_sha)
}

export function buildManifest(
  snapshot: PublicSnapshotV1,
  metadata: PublicSnapshotManifestMetadata,
): PublicSnapshotManifestV1 {
  if (snapshot.schema_version !== 1 || !isNonNegativeInteger(snapshot.summary._total)) {
    throw new Error('Invalid public snapshot for manifest')
  }
  const snapshot_key = snapshotKey(snapshot.generation, snapshot.content_hash)
  if (typeof metadata.git_sha !== 'string' || !LOWERCASE_GIT_SHA.test(metadata.git_sha)) {
    throw new Error('Invalid manifest git_sha')
  }
  return {
    schema_version: 1,
    generation: snapshot.generation,
    snapshot_key,
    content_sha256: snapshot.content_hash,
    published_at: toUtcIso8601(snapshot.published_at, 'published_at'),
    source_observed_at: toUtcIso8601(metadata.source_observed_at, 'source_observed_at'),
    item_count: snapshot.summary._total,
    git_sha: metadata.git_sha,
  }
}

export function parsePublicSnapshotManifestV1(value: unknown): PublicSnapshotManifestV1 {
  if (!isPublicSnapshotManifestV1(value)) throw new Error('Invalid public snapshot manifest')
  return value
}

export function canonicalSnapshotBytes(snapshot: PublicSnapshotV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(snapshot))
}

export function nextSnapshotGeneration(
  verified: Pick<PublicSnapshotV1, 'generation' | 'content_hash'> | null,
  contentHash: string,
): number | null {
  return verified?.content_hash === contentHash ? null : (verified?.generation ?? 0) + 1
}
