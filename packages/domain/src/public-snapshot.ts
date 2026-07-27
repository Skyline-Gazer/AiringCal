import {
  sha256Canonical,
  type PublicCalendarDayV1,
  type PublicCollectionItemV1,
  type PublicSnapshotSummaryV1,
  type PublicSnapshotV1,
} from '@airing-cal/storage'

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const
type PublicCollectionType = typeof COLLECTION_TYPES[number]

const COLLECTION_TYPE_BY_ID: Record<number, PublicCollectionType> = {
  1: 'want',
  2: 'watched',
  3: 'watching',
  4: 'on_hold',
  5: 'dropped',
}

export interface PublicSnapshotInput {
  collections: PublicCollectionItemV1[]
  calendar: PublicCalendarDayV1[]
  content_hash?: string
  published_at?: number
}

function groupCollections(items: PublicCollectionItemV1[]): PublicSnapshotV1['collections'] {
  const grouped: PublicSnapshotV1['collections'] = {
    want: [],
    watched: [],
    watching: [],
    on_hold: [],
    dropped: [],
  }

  for (const item of items) {
    grouped[COLLECTION_TYPE_BY_ID[item.collection_type] ?? 'want'].push(item)
  }
  return grouped
}

function summarize(collections: PublicSnapshotV1['collections']): PublicSnapshotSummaryV1 {
  const summary = {
    want: collections.want.length,
    watched: collections.watched.length,
    watching: collections.watching.length,
    on_hold: collections.on_hold.length,
    dropped: collections.dropped.length,
  }
  return {
    ...summary,
    _total: Object.values(summary).reduce((total, count) => total + count, 0),
  }
}

export async function buildPublicSnapshot(
  input: PublicSnapshotInput,
  generation: number,
): Promise<PublicSnapshotV1> {
  const collections = groupCollections(input.collections)
  const payload = {
    schema_version: 1 as const,
    collections,
    calendar: input.calendar,
    summary: summarize(collections),
  }

  return {
    schema_version: 1,
    generation,
    content_hash: await sha256Canonical(payload),
    collections,
    calendar: input.calendar,
    summary: payload.summary,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePublicSnapshotV1(value: unknown): PublicSnapshotV1 {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error('Unsupported public snapshot schema_version')
  }
  const collections = value.collections
  if (
    !Number.isInteger(value.generation)
    || typeof value.content_hash !== 'string'
    || !isRecord(collections)
    || !Array.isArray(value.calendar)
    || !isRecord(value.summary)
    || COLLECTION_TYPES.some((type) => !Array.isArray(collections[type]))
  ) {
    throw new Error('Invalid public snapshot')
  }
  return value as unknown as PublicSnapshotV1
}

export function snapshotObjectKey(snapshot: PublicSnapshotV1): string {
  return `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`
}
