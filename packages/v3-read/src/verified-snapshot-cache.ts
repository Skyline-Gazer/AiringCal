import type { PublicReleasePointer, PublicStore } from '@airing-cal/v3-core/ports'
import {
  loadVerifiedPublicSnapshot,
  type VerifiedPublicSnapshot,
} from './load-public-snapshot.ts'

export interface VerifiedSnapshotCacheOptions {
  /** Soft pointer revalidate interval; default 60_000 (matches unified collections/calendar s-maxage=60). */
  softTtlMs?: number
  now?: () => number
}

export interface VerifiedSnapshotCache {
  load(store: PublicStore): Promise<VerifiedPublicSnapshot | null>
  clear(): void
}

interface PointerIdentity {
  generation: number
  content_hash: string
  artifact_ref: string
  /** Explicit null when pointer lacks manifest_ref (missing ≠ present). */
  manifest_ref: string | null
}

interface ResidentEntry {
  identity: PointerIdentity
  snapshot: VerifiedPublicSnapshot
  loadedAt: number
}

function identityFromPointer(pointer: PublicReleasePointer): PointerIdentity {
  return {
    generation: pointer.generation,
    content_hash: pointer.content_hash,
    artifact_ref: pointer.artifact_ref,
    manifest_ref: pointer.manifest_ref ?? null,
  }
}

function identitiesMatch(a: PointerIdentity, b: PointerIdentity): boolean {
  return a.generation === b.generation
    && a.content_hash === b.content_hash
    && a.artifact_ref === b.artifact_ref
    && a.manifest_ref === b.manifest_ref
}

function storeWithFixedPointer(store: PublicStore, pointer: PublicReleasePointer): PublicStore {
  return {
    getCurrentRelease: async () => pointer,
    getSnapshotBytes: (ref) => store.getSnapshotBytes(ref),
    putImmutableObject: (key, body, contentType) => store.putImmutableObject(key, body, contentType),
    commitRelease: (expected, next) => store.commitRelease(expected, next),
    ...(store.headObject ? { headObject: (key: string) => store.headObject!(key) } : {}),
  }
}

export function createVerifiedSnapshotCache(
  options?: VerifiedSnapshotCacheOptions,
): VerifiedSnapshotCache {
  const softTtlMs = options?.softTtlMs ?? 60_000
  const now = options?.now ?? Date.now

  let resident: ResidentEntry | null = null
  let inFlight: Promise<VerifiedPublicSnapshot | null> | null = null

  async function fullLoad(
    store: PublicStore,
    knownPointer?: PublicReleasePointer,
  ): Promise<VerifiedPublicSnapshot | null> {
    let capturedPointer: PublicReleasePointer | null = knownPointer ?? null
    const loadStore: PublicStore = knownPointer
      ? storeWithFixedPointer(store, knownPointer)
      : {
          getCurrentRelease: async () => {
            const pointer = await store.getCurrentRelease()
            capturedPointer = pointer
            return pointer
          },
          getSnapshotBytes: (ref) => store.getSnapshotBytes(ref),
          putImmutableObject: (key, body, contentType) => store.putImmutableObject(key, body, contentType),
          commitRelease: (expected, next) => store.commitRelease(expected, next),
          ...(store.headObject ? { headObject: (key: string) => store.headObject!(key) } : {}),
        }

    const loaded = await loadVerifiedPublicSnapshot(loadStore)
    if (!loaded || !capturedPointer) {
      resident = null
      return loaded
    }
    if (
      capturedPointer.generation !== loaded.generation
      || capturedPointer.content_hash !== loaded.content_hash
      || capturedPointer.artifact_ref !== loaded.artifact_ref
    ) {
      resident = null
      return loaded
    }
    resident = {
      identity: identityFromPointer(capturedPointer),
      snapshot: loaded,
      loadedAt: now(),
    }
    return loaded
  }

  async function revalidate(store: PublicStore): Promise<VerifiedPublicSnapshot | null> {
    const pointer = await store.getCurrentRelease()
    if (!pointer) {
      resident = null
      return null
    }
    const nextIdentity = identityFromPointer(pointer)
    if (resident && identitiesMatch(resident.identity, nextIdentity)) {
      resident = {
        ...resident,
        loadedAt: now(),
      }
      return resident.snapshot
    }
    return fullLoad(store, pointer)
  }

  async function runLoad(store: PublicStore): Promise<VerifiedPublicSnapshot | null> {
    if (resident && now() - resident.loadedAt < softTtlMs) {
      return resident.snapshot
    }
    if (resident) return revalidate(store)
    return fullLoad(store)
  }

  return {
    async load(store: PublicStore): Promise<VerifiedPublicSnapshot | null> {
      if (resident && now() - resident.loadedAt < softTtlMs) {
        return resident.snapshot
      }
      if (inFlight) return inFlight
      inFlight = runLoad(store).finally(() => {
        inFlight = null
      })
      return inFlight
    },
    clear() {
      resident = null
      inFlight = null
    },
  }
}
