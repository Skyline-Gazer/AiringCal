/** Immutable public release metadata (platform-neutral). */
export interface PublicReleasePointer {
  schema_version: number
  generation: number
  content_hash: string
  published_at_unix: number
  /** Platform-specific key or URL to the immutable snapshot artifact. */
  artifact_ref: string
}

export interface PublisherCapabilities {
  /** True only when the adapter can atomically swap the current pointer with CAS or equivalent proof. */
  compare_and_swap_pointer: boolean
  immutable_object_store: boolean
  serve_static_assets: boolean
  serve_read_gateway: boolean
}

export interface PublicStore {
  getCurrentRelease(): Promise<PublicReleasePointer | null>
  getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null>
  putImmutableObject(key: string, body: Uint8Array, contentType: string): Promise<void>
  /**
   * Commit the current release pointer after verification.
   * Returns `unsupported` when CAS is unavailable — callers must fail closed for concurrent publishers.
   */
  commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'>
}

export interface PrivateCheckpointStore {
  read(id: string): Promise<Uint8Array | null>
  write(id: string, body: Uint8Array): Promise<void>
  delete(id: string): Promise<void>
}

export interface RuntimeAdapter {
  readonly platform_id: string
  capabilities(): PublisherCapabilities
}

export interface BuilderJobLease {
  job_id: string
  owner_token: string
  expires_at_unix: number
}

/** Local SQLite (or in-memory test double) for builder durable state. */
export interface BuilderStateStore {
  acquireLease(jobId: string, ownerToken: string, ttlSeconds: number, nowUnix?: number): Promise<boolean>
  releaseLease(jobId: string, ownerToken: string): Promise<void>
  getLease(jobId: string): Promise<BuilderJobLease | null>
  setKv(key: string, valueJson: string, nowUnix?: number): Promise<void>
  getKv(key: string): Promise<string | null>
}

export interface Publisher {
  readonly publicStore: PublicStore
  readonly checkpoints: PrivateCheckpointStore
  publishVerifiedRelease(pointer: PublicReleasePointer, snapshotBytes: Uint8Array): Promise<void>
}
