import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { PublicSnapshotInput } from '@airing-cal/domain'
import {
  mergeCollections,
  transformCalendar,
  type BgmCollectionLike,
  type SubjectDetailMap,
  type SubjectImageMap,
  type SubjectMetaMap,
} from '@airing-cal/domain'
import type {
  PublicCalendarDayV1,
  PublicCalendarSubjectV1,
  PublicCollectionItemV1,
  PublicImageRefV1,
} from '@airing-cal/storage'
import type { SubjectMediaPublishHint } from './media-hints.ts'

type PublicImageStatus = 'cached' | 'pending_next_cron' | 'failed' | 'missing_source'

function imageStatusForSize(
  size: 'common' | 'large',
  images: { common: PublicImageRefV1 | null; large: PublicImageRefV1 | null },
  hint: SubjectMediaPublishHint | undefined,
): PublicImageStatus {
  if (images[size]) return 'cached'
  const hasSource = size === 'common' ? hint?.hasSourceCommon : hint?.hasSourceLarge
  if (!hasSource) return 'missing_source'
  if (hint?.errorCode) return 'failed'
  return 'pending_next_cron'
}

function imageStatus(
  images: { common: PublicImageRefV1 | null; large: PublicImageRefV1 | null },
  hint?: SubjectMediaPublishHint,
) {
  return {
    common: imageStatusForSize('common', images, hint),
    large: imageStatusForSize('large', images, hint),
  }
}

function toPublicCollectionItem(
  entry: ReturnType<typeof mergeCollections>['watching'][number],
  hint?: SubjectMediaPublishHint,
): PublicCollectionItemV1 {
  return {
    subject_id: entry.subject_id,
    name: entry.name,
    name_cn: entry.name_cn,
    summary: entry.summary,
    images: entry.images,
    image_status: imageStatus(entry.images, hint),
    eps: entry.eps,
    total_episodes: entry.total_episodes,
    ep_status: entry.ep_status,
    vol_status: entry.vol_status,
    type: entry.type,
    collection_type: entry.collection_type,
    rate: entry.rate,
    nsfw: entry.nsfw,
    date: entry.date,
    tags: entry.tags,
    updated_at: entry.updated_at,
  }
}

function toPublicCalendarDay(
  day: ReturnType<typeof transformCalendar>[number],
  hints: Map<number, SubjectMediaPublishHint>,
): PublicCalendarDayV1 {
  const items: PublicCalendarSubjectV1[] = day.items.map((item) => ({
    subject_id: item.subject_id,
    id: item.id,
    type: item.type,
    name: item.name,
    name_cn: item.name_cn,
    summary: item.summary,
    images: item.images,
    image_status: imageStatus(item.images, hints.get(item.subject_id)),
    nsfw: item.nsfw,
    date: item.date,
    eps: item.eps,
    total_episodes: item.total_episodes,
    ...(item.rating ? { rating: item.rating } : {}),
  }))
  return { weekday: day.weekday, items }
}

export function projectPublicSnapshotInput(
  input: CompleteFullFetch,
  imageMap: SubjectImageMap = new Map(),
  subjectMetaMap: SubjectMetaMap = new Map(),
  subjectDetailMap: SubjectDetailMap = new Map(),
  mediaHints: Map<number, SubjectMediaPublishHint> = new Map(),
): PublicSnapshotInput {
  const collections: BgmCollectionLike[] = input.collections
    .filter((entry) => entry.collection.private !== true)
    .map((entry) => entry.collection as BgmCollectionLike)
  const merged = mergeCollections(collections, imageMap, subjectMetaMap, subjectDetailMap)
  const calendar = transformCalendar(input.calendar, imageMap, subjectMetaMap)
  const flatCollections = [
    ...merged.want,
    ...merged.watched,
    ...merged.watching,
    ...merged.on_hold,
    ...merged.dropped,
  ].map((entry) => toPublicCollectionItem(entry, mediaHints.get(entry.subject_id)))
  return {
    collections: flatCollections,
    calendar: calendar.map((day) => toPublicCalendarDay(day, mediaHints)),
    published_at: input.observedAt,
  }
}
