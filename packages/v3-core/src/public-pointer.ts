/**
 * Mutable release pointer object key, shared by the filesystem and R2 public stores.
 * Kept in a runtime-neutral module so Workers bundles do not pull `node:fs`.
 */
export const PUBLIC_RELEASE_POINTER_KEY = 'public/current-release.json'
