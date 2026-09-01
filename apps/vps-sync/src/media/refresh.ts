import type { MediaResultInput, MediaState } from '../postgres/repositories.ts'
import type { RunContext, MediaSummary } from '../contracts.ts'
import { createHash } from 'node:crypto'
import { imageRef, subjectMetaFromDetail, subjectMetaFromNotFound } from '@airing-cal/domain'

export type MediaCandidate = { subjectId: number; priority: 'new_or_changed' | 'hot' | 'cold' | 'retry' }
export type MediaSubject = NonNullable<MediaResultInput['detail']> & { id: number; name: string; images?: { common?: string; large?: string } }
export type SubjectSession = { current: MediaState | null; save(value: MediaResultInput): Promise<boolean> }
export interface MediaDependencies {
  list(context: RunContext): Promise<MediaCandidate[]>
  withSubject<T>(subjectId: number, work: (session: SubjectSession) => Promise<T>): Promise<T | undefined>
  detail(subjectId: number): Promise<MediaSubject | null>
  image(url: string): Promise<Response>
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
}
const priorities = { new_or_changed: 0, hot: 1, cold: 2, retry: 3 }
const DAY = 86400000
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')

export async function refreshMedia(deps: MediaDependencies, context: RunContext): Promise<MediaSummary> {
  const now = Date.parse(context.observedAt)
  const merged = new Map<number, MediaCandidate>()
  for (const candidate of await deps.list(context)) {
    const prior = merged.get(candidate.subjectId)
    if (!prior || priorities[candidate.priority] < priorities[prior.priority]) merged.set(candidate.subjectId, candidate)
  }
  const candidates = [...merged.values()]
    .sort((a, b) => priorities[a.priority] - priorities[b.priority] || a.subjectId - b.subjectId)
    .filter((candidate) => candidate.priority !== 'cold' || candidate.subjectId % 7 === new Date(now).getUTCDay())
  const summary = { selected: candidates.length, succeeded: 0, failed: 0 }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!
      try {
        const failed = await deps.withSubject(candidate.subjectId, (session) => refreshSubject(deps, context, candidate, session))
        if (failed) summary.failed++
        else if (failed === false) summary.succeeded++
      } catch { summary.failed++ }
    }
  }))
  return summary
}

async function refreshSubject(deps: MediaDependencies, context: RunContext, candidate: MediaCandidate, session: SubjectSession): Promise<boolean | undefined> {
  const { subjectId } = candidate
  const { current } = session
  const now = Date.parse(context.observedAt)
  const changedAfterSuccess = candidate.priority === 'new_or_changed' && current?.deletedAt === null
    && current.status.detail === 'success' && current.status.metadata === 'success'
    && (current.status.image === 'success' || current.status.image === 'missing')
  if (current && ((current.observedAt !== null && Date.parse(current.observedAt) >= now)
    || (!changedAfterSuccess && current.nextRetryAt !== null && Date.parse(current.nextRetryAt) > now))) return undefined
  const result: MediaResultInput = {
    subjectId, runId: context.runId, observedAt: context.observedAt, detail: null, metadata: null,
    imageRefs: current?.imageRefs ? { ...current.imageRefs } : { common: null, large: null },
    detailHash: null, metadataHash: null, imageHash: null, status: {},
    nextRetryAt: null, deletedAt: null, lastSuccessAt: null,
  }
  let failed = false
  try {
    const detail = await deps.detail(subjectId)
    if (detail === null) {
      const { subject_id: _id, ...metadata } = subjectMetaFromNotFound(subjectId, Math.floor(now / 1000))
      result.metadata = metadata; result.metadataHash = hash(JSON.stringify(metadata))
      result.status = { detail: 'not_found', metadata: 'success', image: 'not_found' }
      result.deletedAt = context.observedAt; result.nextRetryAt = new Date(now + DAY).toISOString()
      await session.save(result)
      return false
    }
    if (detail.id !== subjectId || typeof detail.name !== 'string') throw new Error('MEDIA_DETAIL_CONTRACT')
    result.detail = {
      id: detail.id, name: detail.name,
      ...(detail.type !== undefined ? { type: detail.type } : {}),
      ...(detail.name_cn !== undefined ? { name_cn: detail.name_cn } : {}),
      ...(detail.summary !== undefined ? { summary: detail.summary } : {}),
      ...(detail.nsfw !== undefined ? { nsfw: detail.nsfw } : {}),
      ...(detail.date !== undefined ? { date: detail.date } : {}),
      ...(detail.eps !== undefined ? { eps: detail.eps } : {}),
      ...(detail.total_episodes !== undefined ? { total_episodes: detail.total_episodes } : {}),
    }
    const { subject_id: _id, ...metadata } = subjectMetaFromDetail(subjectId, detail, Math.floor(now / 1000))
    result.metadata = metadata
    result.detailHash = hash(JSON.stringify(result.detail))
    result.metadataHash = hash(JSON.stringify({ exists: metadata.exists, nsfw: metadata.nsfw, reason: metadata.reason }))
    result.status = { detail: 'success', metadata: 'success', image: 'missing' }
    let present = 0
    for (const size of ['common', 'large'] as const) {
      const url = detail.images?.[size]
      if (!url) continue
      present++
      try {
        const normalized = new URL(url.startsWith('//') ? `https:${url}` : url)
        if (normalized.protocol !== 'https:' || normalized.username || normalized.password || normalized.port
          || !['lain.bgm.tv', 'lain.bangumi.tv'].includes(normalized.hostname)) throw new Error('MEDIA_URL_INVALID')
        const { bytes, contentType } = await readImage(await deps.image(normalized.href))
        const digest = hash(bytes)
        const reference = imageRef(digest)
        if (context.mode === 'shadow') reference.r2_key = `shadow/${reference.r2_key}`
        const reusable = Object.values(result.imageRefs!).some((old) => old?.hash === digest && old.r2_key === reference.r2_key)
        if (!reusable) await deps.put(reference.r2_key, bytes, contentType)
        result.imageRefs = { ...result.imageRefs!, [size]: reference }
      } catch { failed = true }
    }
    result.status = { ...result.status, image: failed ? 'failed' : present ? 'success' : 'missing' }
    result.imageHash = hash(JSON.stringify(result.imageRefs))
    if (!failed) result.lastSuccessAt = context.observedAt
  } catch {
    failed = true
    result.status = { detail: 'failed', metadata: 'failed', image: 'failed' }
  }
  // Same 6–8 day deterministic spread as the existing refresh lifecycle, in milliseconds.
  result.nextRetryAt = new Date(now + (failed ? 3600000 : 6 * DAY + (subjectId * 997 % 172801) * 1000)).toISOString()
  await session.save(result)
  return failed
}

async function readImage(response: Response): Promise<{ bytes: Uint8Array; contentType: string }> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  const maximum = 8 * 1024 * 1024
  if (response.status !== 200 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(contentType)
    || Number(response.headers.get('content-length')) > maximum || !response.body) {
    await response.body?.cancel()
    throw new Error('MEDIA_IMAGE_INVALID')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maximum) throw new Error('MEDIA_IMAGE_TOO_LARGE')
      chunks.push(part.value)
    }
    if (size === 0) throw new Error('MEDIA_IMAGE_EMPTY')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return { bytes, contentType }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}
