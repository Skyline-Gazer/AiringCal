export const packageBoundary = '@airing-cal/domain'

export type CollectionType = 'want' | 'watched' | 'watching' | 'on_hold' | 'dropped'

export interface ImageRef {
  hash: string
  uri: string
  r2_key: string
}

export interface SubjectImages {
  common: ImageRef | null
  large: ImageRef | null
}

export interface SubjectMeta {
  subject_id: number
  exists: boolean | null
  nsfw: boolean
  checked_at: number
  reason: 'subject_detail' | 'not_found_or_restricted' | 'network_error' | 'upstream_error'
}

export interface BgmCollectionLike {
  subject_id: number
  subject_type: number
  rate: number
  type: number
  comment: string
  tags: string[]
  ep_status: number
  vol_status: number
  updated_at: string
  private: boolean
  subject?: {
    id: number
    name: string
    name_cn: string
    summary: string
    date: string
    eps: number
    total_episodes: number
    images?: { large?: string; common?: string }
    nsfw?: boolean
  }
}

export interface MergedEntry {
  subject_id: number
  name: string
  name_cn: string
  summary: string
  images: SubjectImages
  eps: number
  total_episodes: number
  ep_status: number
  vol_status: number
  type: number
  collection_type: number
  rate: number
  nsfw: boolean
  date: string
  tags: string[]
  updated_at: string
}

export interface MergedCollections {
  want: MergedEntry[]
  watched: MergedEntry[]
  watching: MergedEntry[]
  on_hold: MergedEntry[]
  dropped: MergedEntry[]
  updated_at: string
}

export type SubjectImageMap = Map<number, SubjectImages>
export type SubjectMetaMap = Map<number, Pick<SubjectMeta, 'nsfw'>>

const TYPE_MAP: Record<number, CollectionType> = {
  1: 'want',
  2: 'watched',
  3: 'watching',
  4: 'on_hold',
  5: 'dropped',
}

export function imageRef(hash: string): ImageRef {
  return {
    hash,
    uri: `/image/${hash}`,
    r2_key: `images/${hash}/original`,
  }
}

export function subjectMetaFromNotFound(subjectId: number, checkedAt: number): SubjectMeta {
  return {
    subject_id: subjectId,
    exists: false,
    nsfw: true,
    checked_at: checkedAt,
    reason: 'not_found_or_restricted',
  }
}

function toTimestamp(value: string | undefined): number {
  if (!value) return 0
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function toMergedEntry(collection: BgmCollectionLike, imageMap?: SubjectImageMap, subjectMetaMap?: SubjectMetaMap): MergedEntry {
  const subject = collection.subject
  return {
    subject_id: collection.subject_id,
    name: subject?.name ?? '',
    name_cn: subject?.name_cn ?? '',
    summary: subject?.summary ?? '',
    images: imageMap?.get(collection.subject_id) ?? { common: null, large: null },
    eps: subject?.eps ?? 0,
    total_episodes: subject?.total_episodes ?? 0,
    ep_status: collection.ep_status,
    vol_status: collection.vol_status,
    type: collection.subject_type,
    collection_type: collection.type,
    rate: collection.rate,
    nsfw: subjectMetaMap?.get(collection.subject_id)?.nsfw ?? subject?.nsfw ?? false,
    date: subject?.date ?? '',
    tags: collection.tags ?? [],
    updated_at: collection.updated_at,
  }
}

export function mergeCollections(collections: BgmCollectionLike[], imageMap?: SubjectImageMap, subjectMetaMap?: SubjectMetaMap): MergedCollections {
  const latestBySubject = new Map<number, MergedEntry>()

  for (const collection of collections) {
    const entry = toMergedEntry(collection, imageMap, subjectMetaMap)
    const existing = latestBySubject.get(collection.subject_id)
    if (!existing || toTimestamp(collection.updated_at) > toTimestamp(existing.updated_at)) {
      latestBySubject.set(collection.subject_id, entry)
    }
  }

  const merged: MergedCollections = {
    want: [],
    watched: [],
    watching: [],
    on_hold: [],
    dropped: [],
    updated_at: new Date().toISOString(),
  }
  for (const entry of latestBySubject.values()) {
    merged[TYPE_MAP[entry.collection_type] ?? 'want'].push(entry)
  }
  return merged
}
