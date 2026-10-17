const SNAPSHOT_PREFIX = 'snapshots/v1/'

export interface PublicSnapshotGcOptions {
  /** Relative object keys under the public store root (e.g. snapshots/v1/3-abc.json). */
  snapshotKeys: readonly string[]
  currentArtifactRef: string | null
  pinnedArtifactRefs?: ReadonlySet<string>
  /** Minimum distinct snapshot generations to retain (includes current). */
  minGenerations?: number
  nowUnix?: number
}

export interface PublicSnapshotGcPlan {
  keep: string[]
  delete: string[]
}

function parseGenerationFromSnapshotKey(key: string): number | null {
  if (!key.startsWith(SNAPSHOT_PREFIX) || !key.endsWith('.json')) return null
  const stem = key.slice(SNAPSHOT_PREFIX.length, -'.json'.length)
  const dash = stem.indexOf('-')
  if (dash <= 0) return null
  const generation = Number(stem.slice(0, dash))
  return Number.isSafeInteger(generation) && generation > 0 ? generation : null
}

export function planPublicSnapshotGc(options: PublicSnapshotGcOptions): PublicSnapshotGcPlan {
  const minGenerations = options.minGenerations ?? 5
  const pinned = options.pinnedArtifactRefs ?? new Set<string>()
  const candidates = options.snapshotKeys.filter((key) => parseGenerationFromSnapshotKey(key) !== null)
  const byGeneration = new Map<number, string>()
  for (const key of candidates) {
    const generation = parseGenerationFromSnapshotKey(key)!
    if (!byGeneration.has(generation)) byGeneration.set(generation, key)
  }
  const sortedGenerations = [...byGeneration.keys()].sort((a, b) => b - a)
  const keepGenerations = new Set(sortedGenerations.slice(0, minGenerations))
  const keep = new Set<string>()
  if (options.currentArtifactRef) keep.add(options.currentArtifactRef)
  for (const key of pinned) keep.add(key)
  for (const generation of keepGenerations) {
    const key = byGeneration.get(generation)
    if (key) keep.add(key)
  }
  const deleteKeys = candidates.filter((key) => !keep.has(key)).sort()
  return { keep: [...keep].sort(), delete: deleteKeys }
}

export function listSnapshotObjectKeys(relativePaths: readonly string[]): string[] {
  return relativePaths.filter((key) => parseGenerationFromSnapshotKey(key) !== null)
}
