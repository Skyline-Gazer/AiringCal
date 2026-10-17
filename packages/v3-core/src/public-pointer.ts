import type { PublicReleasePointer } from './ports.ts'

/**
 * Mutable release pointer object key, shared by the filesystem and R2 public stores.
 * Kept in a runtime-neutral module so Workers bundles do not pull `node:fs`.
 */
export const PUBLIC_RELEASE_POINTER_KEY = 'public/current-release.json'

/** Byte equality for immutable-object verification across every public store. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index])
}

/** Validates the mutable release pointer before any CAS decision; throws on a malformed object. */
export function parsePublicReleasePointer(raw: string): PublicReleasePointer {
  const value = JSON.parse(raw) as PublicReleasePointer
  if (
    value.schema_version !== 1
    || !Number.isSafeInteger(value.generation)
    || typeof value.content_hash !== 'string'
    || typeof value.artifact_ref !== 'string'
    || !Number.isSafeInteger(value.published_at_unix)
  ) {
    throw new Error('Invalid public release pointer object')
  }
  return value
}

/** Pointer identity used for CAS: same generation and content hash, or both absent. */
export function releasePointersMatch(
  a: PublicReleasePointer | null,
  b: PublicReleasePointer | null,
): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.content_hash === b.content_hash && a.generation === b.generation
}
