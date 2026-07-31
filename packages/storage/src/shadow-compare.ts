import type {
  PublicCalendarDayV1,
  PublicCollectionItemV1,
  PublicSnapshotSummaryV1,
  PublicSnapshotV1,
  PublicSubjectImagesV1,
} from './d1-types.ts'

type CollectionTypeName = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'

const COLLECTION_TYPES: readonly CollectionTypeName[] = [
  'want',
  'watched',
  'watching',
  'on_hold',
  'dropped',
]

export type NormalizedPublicResult = Omit<
  PublicSnapshotV1,
  'schema_version' | 'generation' | 'content_hash' | 'published_at'
>

export interface LegacyHydration {
  images?: PublicSubjectImagesV1
  nsfw?: boolean
  eps?: number
  total_episodes?: number
  rating?: { score: number; rank: number; total: number }
}

export interface LegacyPublicResult {
  collections: Record<CollectionTypeName, PublicCollectionItemV1[]>
  calendar: PublicCalendarDayV1[]
  summary: PublicSnapshotSummaryV1
}

function sortItems<T extends { subject_id: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.subject_id - b.subject_id)
}

export function normalizePublicResult(snapshot: PublicSnapshotV1): NormalizedPublicResult {
  const collections = {} as NormalizedPublicResult['collections']
  for (const type of COLLECTION_TYPES) {
    collections[type] = sortItems(snapshot.collections[type])
  }
  return {
    collections,
    calendar: [...snapshot.calendar]
      .sort((a, b) => a.weekday.id - b.weekday.id)
      .map((day) => ({ ...day, items: sortItems(day.items) })),
    summary: { ...snapshot.summary },
  }
}

function hydrateItem<T extends { subject_id: number }>(entry: T, hydrated: Record<number, LegacyHydration>): T {
  const patch = hydrated[entry.subject_id]
  if (!patch) return entry
  return {
    ...entry,
    ...(patch.images ? { images: patch.images } : {}),
    ...(patch.nsfw !== undefined ? { nsfw: patch.nsfw } : {}),
    ...(patch.eps !== undefined ? { eps: patch.eps } : {}),
    ...(patch.total_episodes !== undefined ? { total_episodes: patch.total_episodes } : {}),
    ...(patch.rating ? { rating: patch.rating } : {}),
  }
}

export function buildLegacyPublicResult(
  legacy: LegacyPublicResult,
  hydrated: Record<number, LegacyHydration>,
): NormalizedPublicResult {
  const collections = {} as NormalizedPublicResult['collections']
  for (const type of COLLECTION_TYPES) {
    collections[type] = legacy.collections[type].map((entry) => hydrateItem(entry, hydrated))
  }
  const calendar = legacy.calendar.map((day) => ({
    ...day,
    items: day.items.map((entry) => hydrateItem(entry, hydrated)),
  }))
  return normalizePublicResult({
    schema_version: 1,
    generation: 0,
    content_hash: '',
    published_at: 0,
    collections,
    calendar,
    summary: legacy.summary,
  })
}

const MAX_DIFFS = 20

function render(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 60 ? `${text.slice(0, 57)}...` : text
  } catch {
    return String(value)
  }
}

function collectDiffs(left: unknown, right: unknown, path: string, diffs: string[]): void {
  if (diffs.length >= MAX_DIFFS) return
  if (Object.is(left, right)) return
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    diffs.push(`${path}: legacy=${render(left)} vs r2=${render(right)}`)
    return
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
  for (const key of keys) {
    if (diffs.length >= MAX_DIFFS) return
    if (leftRecord[key] === undefined) {
      diffs.push(`${path}.${key}: missing in legacy`)
    } else if (rightRecord[key] === undefined) {
      diffs.push(`${path}.${key}: missing in r2`)
    } else {
      collectDiffs(leftRecord[key], rightRecord[key], `${path}.${key}`, diffs)
    }
  }
}

export function compareShadowSnapshots(
  legacy: NormalizedPublicResult,
  r2: NormalizedPublicResult,
): { equal: boolean; diffs: string[] } {
  const diffs: string[] = []
  collectDiffs(legacy, r2, 'snapshot', diffs)
  return { equal: diffs.length === 0, diffs }
}
