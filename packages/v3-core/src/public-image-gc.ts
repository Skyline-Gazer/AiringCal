import type { PublicSnapshotV1 } from '@airing-cal/storage'

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/

function addImageHash(hashes: Set<string>, hash: string | undefined | null): void {
  if (hash && LOWERCASE_SHA256.test(hash)) hashes.add(hash)
}

export function collectReferencedImageHashes(snapshot: PublicSnapshotV1): Set<string> {
  const hashes = new Set<string>()
  for (const type of ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const) {
    for (const item of snapshot.collections[type]) {
      addImageHash(hashes, item.images.common?.hash ?? null)
      addImageHash(hashes, item.images.large?.hash ?? null)
    }
  }
  for (const day of snapshot.calendar) {
    for (const item of day.items) {
      addImageHash(hashes, item.images.common?.hash ?? null)
      addImageHash(hashes, item.images.large?.hash ?? null)
    }
  }
  return hashes
}

export interface PublicImageGcPlan {
  keep: string[]
  delete: string[]
}

export function planPublicImageGc(options: {
  onDiskHashes: readonly string[]
  referencedHashes: ReadonlySet<string>
  pinnedHashes?: ReadonlySet<string>
}): PublicImageGcPlan {
  const pinned = options.pinnedHashes ?? new Set<string>()
  const keep = new Set<string>()
  for (const hash of options.referencedHashes) keep.add(hash)
  for (const hash of pinned) keep.add(hash)
  const deleteHashes = options.onDiskHashes
    .filter((hash) => LOWERCASE_SHA256.test(hash) && !keep.has(hash))
    .sort()
  return { keep: [...keep].sort(), delete: deleteHashes }
}
