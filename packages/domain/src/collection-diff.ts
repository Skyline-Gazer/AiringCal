import {
  canonicalJson,
  collectionContentHash,
  persistedCollectionSubject,
  type CollectionRow,
  type PublicCollectionItemV1,
} from '@airing-cal/storage'

export interface CollectionInput {
  subject_id: number
  subject_type: number
  rate: number
  type: number
  comment?: string
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
  const comment = entry.comment ?? ''
  const subjectJson = canonicalJson(persistedCollectionSubject(entry.subject_type, entry.private, entry.subject ?? null))
  const contentHash = await collectionContentHash({
    user_id: userId,
    subject_id: entry.subject_id,
    subject_type: entry.subject_type,
    private: entry.private,
    collection_type: entry.type,
    rate: entry.rate,
    tags: entry.tags,
    comment,
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
      comment,
      ep_status: entry.ep_status,
      vol_status: entry.vol_status,
      upstream_updated_at: entry.updated_at,
      subject_json: subjectJson,
      content_hash: contentHash,
      state_version: 1,
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
  const current = new Map<string, Map<number, CollectionRow>>()
  const seen = new Map<string, Set<number>>()
  for (const row of currentRows) {
    const bySubject = current.get(row.user_id) ?? new Map<number, CollectionRow>()
    if (bySubject.has(row.subject_id)) throw new Error(`Duplicate current collection: ${row.user_id}/${row.subject_id}`)
    bySubject.set(row.subject_id, row)
    current.set(row.user_id, bySubject)
  }
  const inserts: CollectionRow[] = []
  const updates: CollectionRow[] = []
  const firstMissing: CollectionRow[] = []
  const confirmedDeleted: CollectionRow[] = []
  const restored: CollectionRow[] = []
  let unchanged = 0

  for (const incoming of incomingCollections) {
    const seenSubjects = seen.get(incoming.row.user_id) ?? new Set<number>()
    if (seenSubjects.has(incoming.row.subject_id)) {
      throw new Error(`Duplicate collection: ${incoming.row.user_id}/${incoming.row.subject_id}`)
    }
    seenSubjects.add(incoming.row.subject_id)
    seen.set(incoming.row.user_id, seenSubjects)
    const previous = current.get(incoming.row.user_id)?.get(incoming.row.subject_id)
    if (!previous) {
      inserts.push({ ...incoming.row, state_version: 1, first_seen_at: observedAt, changed_at: observedAt })
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
      state_version: previous.state_version + 1,
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
      if (seen.get(previous.user_id)?.has(previous.subject_id) || previous.deleted_at !== null) continue
      if (previous.missing_since === null) {
        firstMissing.push({ ...previous, state_version: previous.state_version + 1, missing_since: observedAt })
      } else if (observedAt > previous.missing_since) {
        confirmedDeleted.push({ ...previous, state_version: previous.state_version + 1, deleted_at: observedAt })
      }
    }
  }

  const compareRows = (left: CollectionRow, right: CollectionRow) => {
    const userOrder = left.user_id < right.user_id ? -1 : left.user_id > right.user_id ? 1 : 0
    return userOrder || left.subject_id - right.subject_id
  }
  inserts.sort(compareRows)
  updates.sort(compareRows)
  firstMissing.sort(compareRows)
  confirmedDeleted.sort(compareRows)
  restored.sort(compareRows)
  return { inserts, updates, unchanged, firstMissing, confirmedDeleted, restored }
}
