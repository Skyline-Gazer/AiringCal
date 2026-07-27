import {
  canonicalJson,
  collectionContentHash,
  type CollectionRow,
  type PublicCollectionItemV1,
} from '@airing-cal/storage'

export interface CollectionInput {
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
    type: number
    name: string
    name_cn: string
    summary: string
    nsfw: boolean
    date: string
    eps: number
    total_episodes: number
    images: { large: string; common: string; medium: string; small: string; grid: string }
    rating: { score: number; rank: number; total: number }
  }
}

export interface NormalizedCollection {
  row: CollectionRow
  public_item: PublicCollectionItemV1
}

export interface CollectionDiffPlan {
  inserts: CollectionRow[]
  updates: CollectionRow[]
  unchanged: number
  firstMissing: CollectionRow[]
  confirmedDeleted: CollectionRow[]
  restored: CollectionRow[]
}

export interface CollectionDiffInput {
  current: CollectionRow[]
  incoming: NormalizedCollection[]
  complete: boolean
  observedAt: number
}

function key(userId: string, subjectId: number): string {
  return `${userId}\u0000${subjectId}`
}

function publicProjection(entry: CollectionInput): PublicCollectionItemV1 {
  const subject = entry.subject
  return {
    subject_id: entry.subject_id,
    name: subject?.name ?? '',
    name_cn: subject?.name_cn ?? '',
    summary: subject?.summary ?? '',
    images: { common: null, large: null },
    eps: subject?.eps ?? 0,
    total_episodes: subject?.total_episodes ?? 0,
    ep_status: entry.ep_status,
    vol_status: entry.vol_status,
    type: entry.subject_type,
    collection_type: entry.type,
    rate: entry.rate,
    nsfw: subject?.nsfw ?? false,
    date: subject?.date ?? '',
    tags: [...entry.tags],
    updated_at: entry.updated_at,
  }
}

export async function normalizeCollection(
  userId: string,
  entry: CollectionInput,
): Promise<NormalizedCollection> {
  const subjectJson = canonicalJson(entry.subject ?? null)
  const contentHash = await collectionContentHash({
    user_id: userId,
    subject_id: entry.subject_id,
    subject_type: entry.subject_type,
    collection_type: entry.type,
    rate: entry.rate,
    tags: entry.tags,
    comment: entry.comment,
    ep_status: entry.ep_status,
    vol_status: entry.vol_status,
    upstream_updated_at: entry.updated_at,
    subject: entry.subject ?? null,
  })
  return {
    row: {
      user_id: userId,
      subject_id: entry.subject_id,
      collection_type: entry.type,
      rate: entry.rate,
      tags_json: canonicalJson(entry.tags),
      comment: entry.comment,
      ep_status: entry.ep_status,
      vol_status: entry.vol_status,
      upstream_updated_at: entry.updated_at,
      subject_json: subjectJson,
      content_hash: contentHash,
      temperature: entry.type === 2 ? 'cold' : 'hot',
      first_seen_at: 0,
      changed_at: 0,
      missing_since: null,
      deleted_at: null,
    },
    public_item: publicProjection(entry),
  }
}

export async function planCollectionDiff({
  current: currentRows,
  incoming: incomingCollections,
  observedAt,
  complete,
}: CollectionDiffInput): Promise<CollectionDiffPlan> {
  const current = new Map(currentRows.map((row) => [key(row.user_id, row.subject_id), row]))
  const seen = new Set<string>()
  const inserts: CollectionRow[] = []
  const updates: CollectionRow[] = []
  const firstMissing: CollectionRow[] = []
  const confirmedDeleted: CollectionRow[] = []
  const restored: CollectionRow[] = []
  let unchanged = 0

  for (const incoming of incomingCollections) {
    const incomingKey = key(incoming.row.user_id, incoming.row.subject_id)
    if (seen.has(incomingKey)) throw new Error(`Duplicate collection: ${incoming.row.user_id}/${incoming.row.subject_id}`)
    seen.add(incomingKey)
    const previous = current.get(incomingKey)
    if (!previous) {
      inserts.push({ ...incoming.row, first_seen_at: observedAt, changed_at: observedAt })
      continue
    }
    if (
      previous.content_hash === incoming.row.content_hash
      && previous.missing_since === null
      && previous.deleted_at === null
    ) {
      unchanged++
      continue
    }
    const next = {
      ...incoming.row,
      first_seen_at: previous.first_seen_at,
      changed_at: previous.content_hash === incoming.row.content_hash ? previous.changed_at : observedAt,
      missing_since: null,
      deleted_at: null,
    }
    if (previous.missing_since !== null || previous.deleted_at !== null) restored.push(next)
    else updates.push(next)
  }

  if (complete) {
    for (const previous of currentRows) {
      if (seen.has(key(previous.user_id, previous.subject_id)) || previous.deleted_at !== null) continue
      if (previous.missing_since === null) {
        firstMissing.push({ ...previous, missing_since: observedAt })
      } else {
        confirmedDeleted.push({ ...previous, deleted_at: observedAt })
      }
    }
  }

  return { inserts, updates, unchanged, firstMissing, confirmedDeleted, restored }
}
