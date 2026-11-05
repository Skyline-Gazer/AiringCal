import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  ObjectStorePreconditionError,
  type ConditionalObjectStore,
} from './object-store.ts'

export const DEFAULT_CHECKPOINT_OBJECT_KEY = 'checkpoints/builder.sqlite'
export const DEFAULT_CHECKPOINT_LEASE_KEY = 'checkpoints/lease.json'

export interface CheckpointLeaseBody {
  owner_token: string
  expires_at_unix: number
}

export async function restoreCheckpointToFile(
  store: ConditionalObjectStore,
  sqlitePath: string,
  objectKey = DEFAULT_CHECKPOINT_OBJECT_KEY,
): Promise<{ status: 'missing' } | { status: 'restored'; key: string; etag: string }> {
  const object = await store.get(objectKey)
  if (!object) return { status: 'missing' }
  mkdirSync(dirname(sqlitePath), { recursive: true })
  writeFileSync(sqlitePath, object.body)
  return { status: 'restored', key: objectKey, etag: object.etag }
}

export type UploadCheckpointResult =
  | { status: 'uploaded'; key: string; etag: string }
  | { status: 'precondition_failed'; key: string }

/**
 * C4: upload the checkpoint with CAS. When a prior etag is known (e.g. observed at restore)
 * the put uses If-Match; a first create uses If-None-Match `*`. A failed precondition means
 * another writer replaced the checkpoint — callers must abort before committing the release.
 */
export async function uploadCheckpointFromFile(
  store: ConditionalObjectStore,
  sqlitePath: string,
  objectKey = DEFAULT_CHECKPOINT_OBJECT_KEY,
  options: { priorEtag?: string | null } = {},
): Promise<UploadCheckpointResult> {
  const body = new Uint8Array(readFileSync(sqlitePath))
  try {
    const head = await store.put(objectKey, body, {
      contentType: 'application/octet-stream',
      ...(options.priorEtag != null ? { ifMatch: options.priorEtag } : { ifNoneMatch: '*' }),
    })
    return { status: 'uploaded', key: objectKey, etag: head.etag }
  } catch (error) {
    if (error instanceof ObjectStorePreconditionError) {
      return { status: 'precondition_failed', key: objectKey }
    }
    throw error
  }
}

function parseLease(raw: Uint8Array): CheckpointLeaseBody | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw)) as Partial<CheckpointLeaseBody>
    if (typeof parsed.owner_token !== 'string' || typeof parsed.expires_at_unix !== 'number') {
      return null
    }
    return { owner_token: parsed.owner_token, expires_at_unix: parsed.expires_at_unix }
  } catch {
    return null
  }
}

export async function acquireCheckpointLease(
  store: ConditionalObjectStore,
  options: {
    ownerToken: string
    nowUnix: number
    ttlSeconds: number
    leaseKey?: string
  },
): Promise<
  | { status: 'acquired'; key: string }
  | { status: 'held'; key: string; holder: string; expires_at_unix: number }
> {
  const leaseKey = options.leaseKey ?? DEFAULT_CHECKPOINT_LEASE_KEY
  const next: CheckpointLeaseBody = {
    owner_token: options.ownerToken,
    expires_at_unix: options.nowUnix + options.ttlSeconds,
  }
  const body = new TextEncoder().encode(`${JSON.stringify(next)}\n`)

  const existing = await store.get(leaseKey)
  if (!existing) {
    try {
      await store.put(leaseKey, body, {
        contentType: 'application/json',
        ifNoneMatch: '*',
      })
      return { status: 'acquired', key: leaseKey }
    } catch (error) {
      if (!(error instanceof ObjectStorePreconditionError)) throw error
    }
  }

  const current = existing ?? (await store.get(leaseKey))
  if (!current) {
    // Race: disappeared between get and put; retry once via recursive call would be ok,
    // but fail closed with held unknown.
    return { status: 'held', key: leaseKey, holder: 'unknown', expires_at_unix: options.nowUnix }
  }
  const lease = parseLease(current.body)
  if (!lease) {
    throw new Error(`Corrupt checkpoint lease at ${leaseKey}`)
  }
  if (lease.expires_at_unix > options.nowUnix && lease.owner_token !== options.ownerToken) {
    return {
      status: 'held',
      key: leaseKey,
      holder: lease.owner_token,
      expires_at_unix: lease.expires_at_unix,
    }
  }

  await store.put(leaseKey, body, {
    contentType: 'application/json',
    ifMatch: current.etag,
  })
  return { status: 'acquired', key: leaseKey }
}

export type RenewCheckpointLeaseResult =
  | { status: 'renewed'; expires_at_unix: number }
  | { status: 'lost'; holder: string | null; expired: boolean }

/**
 * C4: renew the lease immediately before the release pointer commit. Renewal fails when the
 * lease is gone, held by another owner, or already expired — the caller must abort without
 * committing the release.
 */
export async function renewCheckpointLease(
  store: ConditionalObjectStore,
  options: {
    ownerToken: string
    nowUnix: number
    ttlSeconds: number
    leaseKey?: string
  },
): Promise<RenewCheckpointLeaseResult> {
  const leaseKey = options.leaseKey ?? DEFAULT_CHECKPOINT_LEASE_KEY
  const current = await store.get(leaseKey)
  if (!current) return { status: 'lost', holder: null, expired: false }
  const lease = parseLease(current.body)
  if (!lease) throw new Error(`Corrupt checkpoint lease at ${leaseKey}`)
  if (lease.owner_token !== options.ownerToken) {
    return { status: 'lost', holder: lease.owner_token, expired: false }
  }
  if (lease.expires_at_unix <= options.nowUnix) {
    return { status: 'lost', holder: lease.owner_token, expired: true }
  }
  const next: CheckpointLeaseBody = {
    owner_token: options.ownerToken,
    expires_at_unix: options.nowUnix + options.ttlSeconds,
  }
  try {
    await store.put(leaseKey, new TextEncoder().encode(`${JSON.stringify(next)}\n`), {
      contentType: 'application/json',
      ifMatch: current.etag,
    })
  } catch (error) {
    if (error instanceof ObjectStorePreconditionError) {
      return { status: 'lost', holder: lease.owner_token, expired: false }
    }
    throw error
  }
  return { status: 'renewed', expires_at_unix: next.expires_at_unix }
}

/**
 * C4: release the lease by expiring it via If-Match put — never by DELETE. Ownership lost
 * (gone, foreign owner, or lost a CAS race) is a no-op.
 */
export async function releaseCheckpointLease(
  store: ConditionalObjectStore,
  ownerToken: string,
  leaseKey = DEFAULT_CHECKPOINT_LEASE_KEY,
): Promise<void> {
  const current = await store.get(leaseKey)
  if (!current) return
  const lease = parseLease(current.body)
  if (!lease || lease.owner_token !== ownerToken) return
  const expired: CheckpointLeaseBody = { owner_token: '', expires_at_unix: 0 }
  try {
    await store.put(leaseKey, new TextEncoder().encode(`${JSON.stringify(expired)}\n`), {
      contentType: 'application/json',
      ifMatch: current.etag,
    })
  } catch (error) {
    if (error instanceof ObjectStorePreconditionError) return
    throw error
  }
}
