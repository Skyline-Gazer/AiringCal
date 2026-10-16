/** Portable v3 release pointer (public store), not tied to KV/R2 field names. */
export type ReleasePointer = {
  generation: number
  contentHash: string
  publishedAt: number
  artifactKey: string
}

export type PublicStoreCapabilities = {
  /** Adapter supports atomic compare-and-swap for the live pointer. */
  compareAndSwapPointer: boolean
  /** Adapter can fetch immutable release artifacts by key. */
  immutableArtifacts: boolean
}

export interface PublicStore {
  readonly capabilities: PublicStoreCapabilities
  getPointer(): Promise<ReleasePointer | null>
  getArtifact(key: string): Promise<Uint8Array | null>
}

export type PrivateCheckpointCapabilities = {
  /** Checkpoints are written on local durable media (SQLite filesystem), not serverless KV. */
  durableLocalWrites: boolean
}

export interface PrivateCheckpointStore {
  readonly capabilities: PrivateCheckpointCapabilities
  saveCheckpoint(checkpointId: string, payload: Uint8Array): Promise<void>
  loadCheckpoint(checkpointId: string): Promise<Uint8Array | null>
}

export type PublishFailureReason =
  | 'VERIFICATION_FAILED'
  | 'POINTER_CAS_UNAVAILABLE'
  | 'INCOMPLETE_INPUT'

export type PublishResult =
  | { ok: true; generation: number }
  | { ok: false; reason: PublishFailureReason }

export interface Publisher {
  publish(input: {
    pointer: ReleasePointer
    artifactsVerified: boolean
  }): Promise<PublishResult>
}

/** Thin runtime read surface; platform adapters implement HTTP mapping separately. */
export interface RuntimeAdapter {
  readonly publicStore: PublicStore
  /** Return null when the path is not handled by this adapter. */
  serveRead(pathname: string, request: Request): Promise<Response | null>
}

/** Fail-closed publish gate shared by Builder and adapters (#70). */
export async function publishRelease(
  store: PublicStore,
  publisher: Publisher,
  input: { pointer: ReleasePointer; artifactsVerified: boolean },
): Promise<PublishResult> {
  if (!input.artifactsVerified) {
    return { ok: false, reason: 'VERIFICATION_FAILED' }
  }
  if (!store.capabilities.compareAndSwapPointer) {
    return { ok: false, reason: 'POINTER_CAS_UNAVAILABLE' }
  }
  if (!store.capabilities.immutableArtifacts) {
    return { ok: false, reason: 'INCOMPLETE_INPUT' }
  }
  return publisher.publish(input)
}
