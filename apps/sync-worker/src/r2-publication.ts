import {
  buildPublicSnapshot,
  parsePublicSnapshotV1,
  type PublicSnapshotInput,
} from '@airing-cal/domain'
import {
  canonicalJson,
  type PublicSnapshotPointerV1,
  type PublicationWriteOwner,
} from '@airing-cal/storage'

const POINTER_KEY = 'public:current'
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

export interface PublicationState {
  getVerifiedPublication(): Promise<PublicSnapshotPointerV1 | undefined>
  getPendingPublication(): Promise<PublicSnapshotPointerV1 | undefined>
  commitPendingPublication(candidate: PublicSnapshotPointerV1): Promise<boolean>
  confirmPublicationAuthorized(
    candidate: PublicSnapshotPointerV1,
  ): Promise<'authorized' | 'already_verified' | 'conflict'>
  claimPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ): Promise<'claimed' | 'busy' | 'already_verified' | 'conflict'>
  confirmPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ): Promise<'active' | 'expired' | 'already_verified' | 'conflict'>
  releasePublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ): Promise<void>
  markPublicationPublished(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ): Promise<void>
}

export interface PublicationDataBucket {
  put(
    key: string,
    value: string,
    options?: { onlyIf?: Headers; httpMetadata?: { contentType?: string } },
  ): Promise<unknown | null>
  get(key: string): Promise<{ key: string; text(): Promise<string> } | null>
}

export interface PublicationPointerKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export interface PublicationResult {
  status: 'unchanged' | 'published' | 'pending'
  generation: number
  contentHash: string
  r2Puts: number
  pointerPuts: number
}

export interface PublishPublicSnapshotArguments {
  state: PublicationState
  dataBucket: PublicationDataBucket
  pointerKv: PublicationPointerKv
  input: PublicSnapshotInput & { content_hash: string }
  now: number
  publicationId: string
}

function parsePointer(value: unknown, label: string): PublicSnapshotPointerV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label} publication state`)
  }
  const pointer = value as Record<string, unknown>
  const keys = Object.keys(pointer)
  const required = ['schema_version', 'generation', 'content_hash', 'r2_key', 'published_at']
  if (
    pointer.schema_version !== 1
    || !required.every((key) => Object.hasOwn(pointer, key))
    || keys.some((key) => !required.includes(key))
    || !Number.isSafeInteger(pointer.generation)
    || (pointer.generation as number) < 0
    || typeof pointer.content_hash !== 'string'
    || !LOWERCASE_SHA256.test(pointer.content_hash)
    || typeof pointer.r2_key !== 'string'
    || !Number.isSafeInteger(pointer.published_at)
    || (pointer.published_at as number) < 0
  ) {
    throw new Error(`Invalid ${label} publication state`)
  }
  const expectedKey = `snapshots/v1/${pointer.generation}-${pointer.content_hash}.json`
  if (pointer.r2_key !== expectedKey) throw new Error(`Invalid ${label} publication object key`)
  return pointer as unknown as PublicSnapshotPointerV1
}

async function readVerified(state: PublicationState): Promise<PublicSnapshotPointerV1 | undefined> {
  const value = await state.getVerifiedPublication()
  return value === undefined ? undefined : parsePointer(value, 'verified')
}

async function readPending(state: PublicationState): Promise<PublicSnapshotPointerV1 | undefined> {
  const value = await state.getPendingPublication()
  return value === undefined ? undefined : parsePointer(value, 'pending')
}

async function prepareCandidate(
  state: PublicationState,
  verified: PublicSnapshotPointerV1 | undefined,
  contentHash: string,
  now: number,
): Promise<PublicSnapshotPointerV1 | { unchanged: PublicSnapshotPointerV1 }> {
  const pending = await readPending(state)
  if (verified?.content_hash === contentHash) return { unchanged: verified }
  if (pending?.content_hash === contentHash) return pending

  const generation = (verified?.generation ?? 0) + 1
  if (!Number.isSafeInteger(generation)) throw new Error('Public snapshot generation exhausted')
  const candidate: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation,
    content_hash: contentHash,
    r2_key: `snapshots/v1/${generation}-${contentHash}.json`,
    published_at: now,
  }
  if (await state.commitPendingPublication(candidate)) return candidate

  const currentVerified = await readVerified(state)
  const currentPending = await readPending(state)
  if (currentVerified?.content_hash === contentHash) return { unchanged: currentVerified }
  if (currentPending?.content_hash === contentHash) return currentPending
  throw new Error('Publication authorization conflict')
}

function isUnchangedCandidate(
  value: PublicSnapshotPointerV1 | { unchanged: PublicSnapshotPointerV1 },
): value is { unchanged: PublicSnapshotPointerV1 } {
  return Object.hasOwn(value, 'unchanged')
}

async function putPointerAndConfirm(
  pointerKv: PublicationPointerKv,
  pointerBytes: string,
): Promise<0 | 1> {
  try {
    await pointerKv.put(POINTER_KEY, pointerBytes)
    return 1
  } catch {
    try {
      return await pointerKv.get(POINTER_KEY) === pointerBytes ? 1 : 0
    } catch {
      return 0
    }
  }
}

async function releasePublicationWrite(
  state: PublicationState,
  candidate: PublicSnapshotPointerV1,
  owner: PublicationWriteOwner,
): Promise<void> {
  try {
    await state.releasePublicationWrite(candidate, owner)
  } catch {
    // Retaining the claim is safer than allowing an unfenced stale pointer write.
  }
}

export async function publishPublicSnapshot(
  { state, dataBucket, pointerKv, input, now, publicationId }: PublishPublicSnapshotArguments,
): Promise<PublicationResult> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid publication time')
  if (typeof publicationId !== 'string') throw new Error('Invalid publication identity')
  const validationSnapshot = await buildPublicSnapshot({ ...input, published_at: now }, 0)
  await parsePublicSnapshotV1(validationSnapshot)
  if (validationSnapshot.content_hash !== input.content_hash) {
    throw new Error('Invalid publication input content_hash')
  }

  const verified = await readVerified(state)
  if (verified?.content_hash === validationSnapshot.content_hash) {
    return {
      status: 'unchanged',
      generation: verified.generation,
      contentHash: verified.content_hash,
      r2Puts: 0,
      pointerPuts: 0,
    }
  }

  const prepared = await prepareCandidate(state, verified, validationSnapshot.content_hash, now)
  if (isUnchangedCandidate(prepared)) {
    return {
      status: 'unchanged',
      generation: prepared.unchanged.generation,
      contentHash: prepared.unchanged.content_hash,
      r2Puts: 0,
      pointerPuts: 0,
    }
  }
  const candidate = prepared
  const initialAuthorization = await state.confirmPublicationAuthorized(candidate)
  if (initialAuthorization === 'conflict') throw new Error('Publication authorization conflict')
  if (initialAuthorization === 'already_verified') {
    return {
      status: 'published',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts: 0,
      pointerPuts: 0,
    }
  }
  const snapshot = await buildPublicSnapshot({
    ...input,
    published_at: candidate.published_at,
  }, candidate.generation)
  if (snapshot.content_hash !== candidate.content_hash) {
    throw new Error('Pending publication content_hash mismatch')
  }
  const expectedKey = `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`
  if (candidate.r2_key !== expectedKey) throw new Error('Pending publication object key mismatch')

  const objectBytes = canonicalJson(snapshot)
  const putResult = await dataBucket.put(candidate.r2_key, objectBytes, {
    onlyIf: new Headers({ 'If-None-Match': '*' }),
    httpMetadata: { contentType: 'application/json' },
  })
  const r2Puts = putResult === null ? 0 : 1

  const stored = await dataBucket.get(candidate.r2_key)
  if (stored === null) throw new Error('Published R2 snapshot is missing')
  const storedBytes = await stored.text()
  let storedValue: unknown
  try {
    storedValue = JSON.parse(storedBytes)
  } catch {
    throw new Error('Published R2 snapshot is not valid JSON')
  }
  const parsed = await parsePublicSnapshotV1(storedValue)
  if (parsed.generation !== candidate.generation) {
    throw new Error('Published R2 snapshot generation mismatch')
  }
  if (parsed.content_hash !== candidate.content_hash) {
    throw new Error('Published R2 snapshot content_hash mismatch')
  }
  if (stored.key !== candidate.r2_key) throw new Error('Published R2 snapshot object key mismatch')
  if (storedBytes !== objectBytes) throw new Error('Published R2 snapshot bytes mismatch')

  const owner: PublicationWriteOwner = {
    publication_id: publicationId,
    attempt_token: crypto.randomUUID(),
  }
  const claim = await state.claimPublicationWrite(candidate, owner)
  if (claim === 'conflict') throw new Error('Publication authorization conflict')
  if (claim === 'already_verified') {
    return {
      status: 'published',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts,
      pointerPuts: 0,
    }
  }
  if (claim === 'busy') {
    return {
      status: 'pending',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts,
      pointerPuts: 0,
    }
  }

  const confirmation = await state.confirmPublicationWrite(candidate, owner)
  if (confirmation === 'already_verified') {
    return {
      status: 'published',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts,
      pointerPuts: 0,
    }
  }
  if (confirmation !== 'active') {
    await releasePublicationWrite(state, candidate, owner)
    return {
      status: 'pending',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts,
      pointerPuts: 0,
    }
  }

  const pointerBytes = canonicalJson(candidate)
  const pointerPuts = await putPointerAndConfirm(pointerKv, pointerBytes)
  if (pointerPuts === 0) {
    await releasePublicationWrite(state, candidate, owner)
    return {
      status: 'pending',
      generation: candidate.generation,
      contentHash: candidate.content_hash,
      r2Puts,
      pointerPuts,
    }
  }

  try {
    await state.markPublicationPublished(candidate, owner)
  } catch {
    let observed: PublicSnapshotPointerV1 | undefined
    try {
      observed = await readVerified(state)
    } catch {
      await releasePublicationWrite(state, candidate, owner)
      throw new Error('Publication verified-state readback failed')
    }
    if (canonicalJson(observed) !== pointerBytes) {
      await releasePublicationWrite(state, candidate, owner)
      return {
        status: 'pending',
        generation: candidate.generation,
        contentHash: candidate.content_hash,
        r2Puts,
        pointerPuts,
      }
    }
  }
  return {
    status: 'published',
    generation: candidate.generation,
    contentHash: candidate.content_hash,
    r2Puts,
    pointerPuts,
  }
}
