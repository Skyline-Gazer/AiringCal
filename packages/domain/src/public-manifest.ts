import { type PublicSnapshotV1 } from '@airing-cal/storage'

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const LOWERCASE_GIT_SHA = /^[0-9a-f]{40}$/
const MANIFEST_KEYS = [
  'schema_version', 'generation', 'snapshot_key', 'content_sha256',
  'published_at', 'source_observed_at', 'item_count', 'git_sha',
] as const

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
  source_observed_at: string
  git_sha: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isSafeInteger(timestamp) && new Date(timestamp).toISOString() === value
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.length === MANIFEST_KEYS.length
    && MANIFEST_KEYS.every((key) => Object.hasOwn(value, key))
}

export function snapshotKey(generation: number, hash: string): string {
  if (!isNonNegativeInteger(generation) || !LOWERCASE_SHA256.test(hash)) {
    throw new Error('Invalid snapshot key')
  }
  return `snapshots/v1/${generation}-${hash}.json`
}

export function buildManifest(
  snapshot: PublicSnapshotV1,
  metadata: PublicSnapshotManifestMetadata,
): PublicSnapshotManifestV1 {
  const publishedAt = new Date(snapshot.published_at * 1000).toISOString()
  const manifest: PublicSnapshotManifestV1 = {
    schema_version: 1,
    generation: snapshot.generation,
    snapshot_key: snapshotKey(snapshot.generation, snapshot.content_hash),
    content_sha256: snapshot.content_hash,
    published_at: publishedAt,
    source_observed_at: metadata.source_observed_at,
    item_count: snapshot.summary._total,
    git_sha: metadata.git_sha,
  }
  return parsePublicSnapshotManifestV1(manifest)
}

export function parsePublicSnapshotManifestV1(value: unknown): PublicSnapshotManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value)
    || value.schema_version !== 1
    || !isNonNegativeInteger(value.generation)
    || typeof value.content_sha256 !== 'string' || !LOWERCASE_SHA256.test(value.content_sha256)
    || typeof value.snapshot_key !== 'string'
    || value.snapshot_key !== `snapshots/v1/${value.generation}-${value.content_sha256}.json`
    || !isUtcIsoTimestamp(value.published_at)
    || !isUtcIsoTimestamp(value.source_observed_at)
    || !isNonNegativeInteger(value.item_count)
    || typeof value.git_sha !== 'string' || !LOWERCASE_GIT_SHA.test(value.git_sha)
  ) {
    throw new Error('Invalid public snapshot manifest')
  }
  return value as unknown as PublicSnapshotManifestV1
}
