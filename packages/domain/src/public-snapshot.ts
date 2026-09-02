import {
  canonicalJson,
  sha256Canonical,
  type PublicCalendarDayV1,
  type PublicCalendarSubjectV1,
  type PublicCollectionItemV1,
  type PublicImageRefV1,
  type PublicSnapshotSummaryV1,
  type PublicSnapshotV1,
  type PublicSubjectImagesV1,
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
const COLLECTION_TYPE_ID: Record<PublicCollectionType, number> = {
  want: 1,
  watched: 2,
  watching: 3,
  on_hold: 4,
  dropped: 5,
}
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const IMAGE_STATUS_VALUES = new Set([
  'cached',
  'queued',
  'failed',
  'missing_source',
  'pending_next_cron',
])

export interface PublicSnapshotInput {
  collections: PublicCollectionItemV1[]
  calendar: PublicCalendarDayV1[]
  published_at: number
  content_hash?: string
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
    const type = COLLECTION_TYPE_BY_ID[item.collection_type]
    if (!type) throw new Error(`Unsupported collection_type: ${item.collection_type}`)
    grouped[type].push(item)
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

function snapshotPayload(snapshot: Pick<PublicSnapshotV1, 'collections' | 'calendar' | 'summary'>) {
  return {
    schema_version: 1 as const,
    collections: snapshot.collections,
    calendar: snapshot.calendar,
    summary: snapshot.summary,
  }
}

export async function buildPublicSnapshot(
  input: PublicSnapshotInput,
  generation: number,
): Promise<PublicSnapshotV1> {
  if (!isNonNegativeInteger(generation)) throw new Error('Invalid snapshot generation')
  if (!isNonNegativeInteger(input.published_at)) throw new Error('Invalid snapshot published_at')
  const collections = groupCollections(input.collections)
  const stable = {
    collections,
    calendar: input.calendar,
    summary: summarize(collections),
  }

  const snapshot: PublicSnapshotV1 = {
    schema_version: 1,
    generation,
    content_hash: await sha256Canonical(snapshotPayload(stable)),
    published_at: input.published_at,
    ...stable,
  }
  if (!validateSnapshotStructure(snapshot)) throw new Error('Invalid public snapshot')
  return snapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value)
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key))
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isImageRef(value: unknown): value is PublicImageRefV1 {
  return isRecord(value)
    && hasExactKeys(value, ['hash', 'uri', 'r2_key'])
    && typeof value.hash === 'string'
    && LOWERCASE_SHA256.test(value.hash)
    && typeof value.uri === 'string'
    && typeof value.r2_key === 'string'
}

function isImages(value: unknown): value is PublicSubjectImagesV1 {
  return isRecord(value)
    && hasExactKeys(value, ['common', 'large'])
    && (value.common === null || isImageRef(value.common))
    && (value.large === null || isImageRef(value.large))
}

function isImageStatus(value: unknown): value is { common: string; large: string } {
  return isRecord(value)
    && hasExactKeys(value, ['common', 'large'])
    && typeof value.common === 'string'
    && IMAGE_STATUS_VALUES.has(value.common)
    && typeof value.large === 'string'
    && IMAGE_STATUS_VALUES.has(value.large)
}

function isRating(value: unknown): value is { score: number; rank: number; total: number } {
  return isRecord(value)
    && hasExactKeys(value, ['score', 'rank', 'total'])
    && isFiniteNumber(value.score)
    && isNonNegativeInteger(value.rank)
    && isNonNegativeInteger(value.total)
}

function isPublicCollectionItem(value: unknown): value is PublicCollectionItemV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'subject_id', 'name', 'name_cn', 'summary', 'images', 'image_status',
    'eps', 'total_episodes',
    'ep_status', 'vol_status', 'type', 'collection_type', 'rate', 'nsfw', 'date',
    'tags', 'updated_at',
  ], ['rating'])) return false

  return isNonNegativeInteger(value.subject_id)
    && typeof value.name === 'string'
    && typeof value.name_cn === 'string'
    && typeof value.summary === 'string'
    && isImages(value.images)
    && isImageStatus(value.image_status)
    && (value.rating === undefined || isRating(value.rating))
    && isNonNegativeInteger(value.eps)
    && isNonNegativeInteger(value.total_episodes)
    && isNonNegativeInteger(value.ep_status)
    && isNonNegativeInteger(value.vol_status)
    && isNonNegativeInteger(value.type)
    && isNonNegativeInteger(value.collection_type)
    && COLLECTION_TYPE_BY_ID[value.collection_type] !== undefined
    && isNonNegativeInteger(value.rate)
    && typeof value.nsfw === 'boolean'
    && typeof value.date === 'string'
    && Array.isArray(value.tags)
    && value.tags.every((tag) => typeof tag === 'string')
    && typeof value.updated_at === 'string'
}

function isPublicCalendarSubject(value: unknown): value is PublicCalendarSubjectV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    'subject_id', 'id', 'type', 'name', 'name_cn', 'summary', 'images',
    'image_status', 'nsfw',
    'date', 'eps', 'total_episodes',
  ], ['rating'])) return false
  const rating = value.rating

  return isNonNegativeInteger(value.subject_id)
    && isNonNegativeInteger(value.id)
    && value.subject_id === value.id
    && isNonNegativeInteger(value.type)
    && typeof value.name === 'string'
    && typeof value.name_cn === 'string'
    && typeof value.summary === 'string'
    && isImages(value.images)
    && isImageStatus(value.image_status)
    && typeof value.nsfw === 'boolean'
    && typeof value.date === 'string'
    && isNonNegativeInteger(value.eps)
    && isNonNegativeInteger(value.total_episodes)
    && (rating === undefined || isRating(rating))
}

function isCalendarDay(value: unknown): value is PublicCalendarDayV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['weekday', 'items']) || !isRecord(value.weekday)) return false
  return hasExactKeys(value.weekday, ['en', 'cn', 'ja', 'id'])
    && typeof value.weekday.en === 'string'
    && typeof value.weekday.cn === 'string'
    && typeof value.weekday.ja === 'string'
    && isNonNegativeInteger(value.weekday.id)
    && Array.isArray(value.items)
    && value.items.every(isPublicCalendarSubject)
}

function isSummary(value: unknown, collections: PublicSnapshotV1['collections']): value is PublicSnapshotSummaryV1 {
  if (!isRecord(value) || !hasExactKeys(value, [...COLLECTION_TYPES, '_total'])) return false
  const counts = COLLECTION_TYPES.map((type) => value[type])
  return counts.every(isNonNegativeInteger)
    && isNonNegativeInteger(value._total)
    && COLLECTION_TYPES.every((type) => value[type] === collections[type].length)
    && value._total === counts.reduce<number>((total, count) => total + (count as number), 0)
}

function parseCollections(value: unknown): PublicSnapshotV1['collections'] | null {
  if (!isRecord(value) || !hasExactKeys(value, COLLECTION_TYPES)) return null
  for (const type of COLLECTION_TYPES) {
    const items = value[type]
    if (!Array.isArray(items) || !items.every(isPublicCollectionItem)) return null
    if (items.some((item) => item.collection_type !== COLLECTION_TYPE_ID[type])) return null
  }
  return value as unknown as PublicSnapshotV1['collections']
}

function validateSnapshotStructure(value: unknown): PublicSnapshotV1 | null {
  if (!isRecord(value) || value.schema_version !== 1) return null
  const collections = parseCollections(value.collections)
  if (
    !hasExactKeys(value, [
      'schema_version', 'generation', 'content_hash', 'published_at',
      'collections', 'calendar', 'summary',
    ])
    || !isNonNegativeInteger(value.generation)
    || !isNonNegativeInteger(value.published_at)
    || typeof value.content_hash !== 'string'
    || !LOWERCASE_SHA256.test(value.content_hash)
    || collections === null
    || !Array.isArray(value.calendar)
    || !value.calendar.every(isCalendarDay)
    || !isSummary(value.summary, collections)
  ) {
    return null
  }
  return value as unknown as PublicSnapshotV1
}

export async function parsePublicSnapshotV1(value: unknown): Promise<PublicSnapshotV1> {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error('Unsupported public snapshot schema_version')
  }
  const snapshot = validateSnapshotStructure(value)
  if (!snapshot) throw new Error('Invalid public snapshot')
  if (await sha256Canonical(snapshotPayload(snapshot)) !== snapshot.content_hash) {
    throw new Error('Invalid public snapshot content_hash')
  }
  return snapshot
}

export function snapshotObjectKey(snapshot: PublicSnapshotV1): string {
  return `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`
}

/**
 * Returns the canonical UTF-8 representation stored in immutable snapshot objects.
 * The public envelope remains present; only content_hash excludes runtime fields.
 */
export function canonicalSnapshotBytes(snapshot: PublicSnapshotV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(snapshot))
}
