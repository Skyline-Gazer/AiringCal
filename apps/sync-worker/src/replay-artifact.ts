import { canonicalJson, sha256Canonical } from '@airing-cal/storage'

const REPLAY_ARTIFACT_CHUNK_CHARS = 128_000
const REPLAY_ARTIFACT_MANIFEST_MAX_BYTES = 100_000
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

export type ReplayArtifactKind = 'collection' | 'media_pending' | 'prepared'

interface ReplayArtifactManifestEnvelope {
  schema_version: 2
  input_hash: string
  artifact: {
    kind: ReplayArtifactKind
    aggregate_hash: string
    byte_length: number
    chunk_count: number
    chunk_hashes: string[]
  }
}

export interface LoadedReplayArtifact {
  artifactJson: string
  manifestJson: string
  kind: ReplayArtifactKind | undefined
  chunkKeys: string[]
}

export interface ReplayArtifactStore {
  getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined>
  putAppState<T>(key: string, value: T): Promise<void>
  deleteAppStateKeys(keys: string[]): Promise<void>
}

export interface ReplayArtifactCleanupStore extends ReplayArtifactStore {
  getSyncRun(instanceId: string): Promise<{ result_json: string | null } | undefined>
}

function artifactChunkKey(instanceId: string, aggregateHash: string, index: number): string {
  return `sync:artifact:${instanceId}:${aggregateHash}:${index}`
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

export async function persistReplayArtifact(
  store: ReplayArtifactStore,
  instanceId: string,
  inputHash: string,
  kind: ReplayArtifactKind,
  artifactJson: string,
): Promise<LoadedReplayArtifact> {
  const chunks: string[] = []
  for (let offset = 0; offset < artifactJson.length; offset += REPLAY_ARTIFACT_CHUNK_CHARS) {
    chunks.push(artifactJson.slice(offset, offset + REPLAY_ARTIFACT_CHUNK_CHARS))
  }
  if (chunks.length === 0) chunks.push('')
  const aggregateHash = await sha256Canonical(artifactJson)
  const chunkHashes = await Promise.all(chunks.map((chunk) => sha256Canonical(chunk)))
  const chunkKeys = chunks.map((_, index) => artifactChunkKey(instanceId, aggregateHash, index))
  const manifestJson = canonicalJson({
    schema_version: 2,
    input_hash: inputHash,
    artifact: {
      kind,
      aggregate_hash: aggregateHash,
      byte_length: utf8Length(artifactJson),
      chunk_count: chunks.length,
      chunk_hashes: chunkHashes,
    },
  } satisfies ReplayArtifactManifestEnvelope)
  if (utf8Length(manifestJson) >= REPLAY_ARTIFACT_MANIFEST_MAX_BYTES) {
    throw new Error('Replay artifact manifest exceeds bounded size')
  }
  const writtenChunkKeys: string[] = []
  try {
    for (let index = 0; index < chunks.length; index++) {
      await store.putAppState(chunkKeys[index]!, chunks[index]!)
      writtenChunkKeys.push(chunkKeys[index]!)
    }
  } catch (error) {
    try {
      if (writtenChunkKeys.length > 0) await store.deleteAppStateKeys(writtenChunkKeys)
    } catch {
      // Preserve the originating chunk-write failure; cleanup is best effort.
    }
    throw error
  }
  return { artifactJson, manifestJson, kind, chunkKeys }
}

export async function loadReplayArtifact(
  store: ReplayArtifactStore,
  resultJson: string | null,
  expectedInputHash: string,
  instanceId: string,
): Promise<LoadedReplayArtifact | undefined> {
  if (resultJson === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw new Error('Invalid replay artifact manifest JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid replay artifact manifest')
  }
  const candidate = parsed as Partial<ReplayArtifactManifestEnvelope>
  if (candidate.schema_version !== 2) {
    return { artifactJson: resultJson, manifestJson: resultJson, kind: undefined, chunkKeys: [] }
  }
  const artifact = candidate.artifact
  if (
    candidate.input_hash !== expectedInputHash
    || typeof artifact !== 'object'
    || artifact === null
    || Array.isArray(artifact)
    || (artifact.kind !== 'collection'
      && artifact.kind !== 'media_pending'
      && artifact.kind !== 'prepared')
    || typeof artifact.aggregate_hash !== 'string'
    || !LOWERCASE_SHA256.test(artifact.aggregate_hash)
    || !Number.isSafeInteger(artifact.byte_length)
    || artifact.byte_length < 0
    || !Number.isSafeInteger(artifact.chunk_count)
    || artifact.chunk_count < 1
    || !Array.isArray(artifact.chunk_hashes)
    || artifact.chunk_hashes.length !== artifact.chunk_count
    || !artifact.chunk_hashes.every((hash) =>
      typeof hash === 'string' && LOWERCASE_SHA256.test(hash))
  ) {
    throw new Error('Invalid replay artifact manifest')
  }
  const chunks: string[] = []
  const chunkKeys: string[] = []
  for (let index = 0; index < artifact.chunk_count; index++) {
    const key = artifactChunkKey(instanceId, artifact.aggregate_hash, index)
    const chunk = await store.getAppState(key, (value) => {
      if (typeof value !== 'string') throw new Error('Invalid replay artifact chunk')
      return value
    })
    if (chunk === undefined) throw new Error('Missing replay artifact chunk')
    if (chunk.length > REPLAY_ARTIFACT_CHUNK_CHARS) {
      throw new Error('Invalid replay artifact chunk size')
    }
    if (await sha256Canonical(chunk) !== artifact.chunk_hashes[index]) {
      throw new Error('Invalid replay artifact chunk hash')
    }
    chunks.push(chunk)
    chunkKeys.push(key)
  }
  const artifactJson = chunks.join('')
  if (
    utf8Length(artifactJson) !== artifact.byte_length
    || await sha256Canonical(artifactJson) !== artifact.aggregate_hash
  ) {
    throw new Error('Invalid replay artifact aggregate')
  }
  return {
    artifactJson,
    manifestJson: resultJson,
    kind: artifact.kind,
    chunkKeys,
  }
}

export async function cleanupReplayArtifactIfUnreferenced(
  store: ReplayArtifactCleanupStore,
  instanceId: string,
  artifact: LoadedReplayArtifact,
): Promise<boolean> {
  if (artifact.chunkKeys.length === 0) return false
  const keyPrefix = `sync:artifact:${instanceId}:`
  if (!artifact.chunkKeys.every((key) => key.startsWith(keyPrefix))) {
    throw new Error('Replay artifact cleanup instance mismatch')
  }
  const currentRun = await store.getSyncRun(instanceId)
  if (currentRun?.result_json === artifact.manifestJson) return false
  await store.deleteAppStateKeys(artifact.chunkKeys)
  return true
}
