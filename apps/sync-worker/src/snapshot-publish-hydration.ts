import {
  imageRefsFromStatus,
  mergeCollections,
  transformCalendar,
  withSubjectDetail,
  type SubjectDetailLike,
  type SubjectDetailMap,
  type SubjectMeta,
} from '@airing-cal/domain'
import {
  imageStatusKey,
  KVStorage,
  subjectDetailKey,
  subjectMetaKey,
  type CollectionType,
} from '@airing-cal/storage'
import type { BgmCollection } from '@airing-cal/bgm-api'

const HYDRATION_CONCURRENCY = 12

async function mapConcurrent<T, R>(items: Iterable<T>, concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const list = [...items]
  const results: R[] = new Array(list.length)
  let index = 0
  async function worker() {
    while (index < list.length) {
      const current = index++
      results[current] = await mapper(list[current]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, () => worker()))
  return results
}

export function calendarSubjectIds(calendar: unknown[]): number[] {
  const ids = new Set<number>()
  for (const day of calendar as any[]) {
    for (const item of day?.items ?? []) {
      if (typeof item?.id === 'number') ids.add(item.id)
      else if (typeof item?.subject_id === 'number') ids.add(item.subject_id)
    }
  }
  return [...ids]
}

function enrichCalendarWithSubjectDetails(calendar: unknown[], details: SubjectDetailMap): unknown[] {
  return (calendar as any[]).map((day) => ({
    ...day,
    items: (day.items ?? []).map((subject: any) => withSubjectDetail(subject, details.get(subject.id) ?? null)),
  }))
}

async function loadSubjectDetailMap(storage: KVStorage, subjectIds: Iterable<number>): Promise<SubjectDetailMap> {
  const map: SubjectDetailMap = new Map()
  await mapConcurrent(subjectIds, HYDRATION_CONCURRENCY, async (subjectId) => {
    const cached = await storage.get<{ subject?: unknown }>(subjectDetailKey(subjectId))
    const subject = cached?.subject
    if (subject && typeof subject === 'object') {
      map.set(subjectId, subject as SubjectDetailLike)
    }
  })
  return map
}

async function loadImageStatusMap(storage: KVStorage, subjectIds: Iterable<number>) {
  const map = new Map<number, unknown>()
  await mapConcurrent(subjectIds, HYDRATION_CONCURRENCY, async (subjectId) => {
    const status = await storage.get(imageStatusKey(subjectId))
    if (status) map.set(subjectId, status)
  })
  return map
}

async function loadSubjectMetaMap(storage: KVStorage, subjectIds: Iterable<number>): Promise<Map<number, SubjectMeta>> {
  const map = new Map<number, SubjectMeta>()
  await mapConcurrent(subjectIds, HYDRATION_CONCURRENCY, async (subjectId) => {
    const meta = await storage.get<SubjectMeta>(subjectMetaKey(subjectId))
    if (meta) map.set(subjectId, meta)
  })
  return map
}

function imageStatusField(status: { status?: string } | null | undefined): string {
  return typeof status?.status === 'string' ? status.status : 'pending_next_cron'
}

export async function buildMergedCollectionsForPublish(
  collections: BgmCollection[],
  calendar: unknown[],
  kv: KVStorage,
) {
  const ids = [...new Set([
    ...collections.map((entry) => entry.subject_id),
    ...calendarSubjectIds(calendar),
  ])]
  const [imageStatuses, subjectMetaMap, subjectDetailMap] = await Promise.all([
    loadImageStatusMap(kv, ids),
    loadSubjectMetaMap(kv, ids),
    loadSubjectDetailMap(kv, calendarSubjectIds(calendar)),
  ])
  const imageMap = new Map(ids.map((subjectId) => [
    subjectId,
    imageRefsFromStatus(imageStatuses.get(subjectId) as Parameters<typeof imageRefsFromStatus>[0]),
  ]))
  return mergeCollections(collections, imageMap, subjectMetaMap, subjectDetailMap)
}

export async function buildCalendarSnapshotForPublish(calendar: unknown[], kv: KVStorage) {
  const ids = calendarSubjectIds(calendar)
  const [imageStatuses, subjectMetaMap, subjectDetailMap] = await Promise.all([
    loadImageStatusMap(kv, ids),
    loadSubjectMetaMap(kv, ids),
    loadSubjectDetailMap(kv, ids),
  ])
  const imageMap = new Map(ids.map((subjectId) => [
    subjectId,
    imageRefsFromStatus(imageStatuses.get(subjectId) as Parameters<typeof imageRefsFromStatus>[0]),
  ]))
  const enriched = enrichCalendarWithSubjectDetails(calendar, subjectDetailMap)
  const snapshot = transformCalendar(enriched as any[], imageMap, subjectMetaMap)
  return snapshot.map((day) => ({
    ...day,
    items: day.items.map((item) => {
      const status = imageStatuses.get(item.subject_id) as { common?: { status?: string }; large?: { status?: string } } | undefined
      return {
        ...item,
        image_status: {
          common: imageStatusField(status?.common),
          large: imageStatusField(status?.large),
        },
      }
    }),
  }))
}
