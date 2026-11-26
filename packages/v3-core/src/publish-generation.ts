import type { PublicSnapshotV1 } from '@airing-cal/storage'

export function nextSnapshotGeneration(
  verified: PublicSnapshotV1 | null,
  contentHash: string,
): number | null {
  return verified?.content_hash === contentHash ? null : (verified?.generation ?? 0) + 1
}
