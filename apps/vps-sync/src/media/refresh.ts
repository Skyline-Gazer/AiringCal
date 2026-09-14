import { createHash } from 'node:crypto'
import type {
  MediaImageRefs,
  MediaResultInput,
  MediaState,
} from '../postgres/repositories.js'
import type { MediaSummary, RunContext } from '../contracts.js'

export type MediaCandidate = { subjectId: number; priority: 'new_or_changed' | 'hot' | 'cold' | 'retry' }
export type MediaSubject = NonNullable<MediaResultInput['detail']> & {
  id: number
  name: string
  images?: { common?: string | null; large?: string | null }
}
export type SubjectSession = { current: MediaState | null; save(value: MediaResultInput): Promise<boolean> }
export interface MediaDependencies {
  list(context: RunContext): Promise<MediaCandidate[]>
  withSubject<T>(subjectId: number, work: (session: SubjectSession) => Promise<T>): Promise<T | undefined>
  detail(subjectId: number): Promise<MediaSubject | null>
  image(url: string): Promise<Response>
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>
}

const PRIORITY: Record<MediaCandidate['priority'], number> = {
  new_or_changed: 0,
  hot: 1,
  cold: 2,
  retry: 3,
}
const DAY_MS = 86_400_000
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const RETRY_MS = 3_600_000
const TOMBSTONE_MS = DAY_MS
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'])
const IMAGE_HOSTS = new Set(['lain.bgm.tv', 'lain.bangumi.tv'])

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'number'
    ? (value <= 1_000_000_000_000 ? value * 1_000 : value)
    : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function imageReference(hash: string, mode: RunContext['mode']): { hash: string; uri: string; r2_key: string } {
  const base = `images/${hash}/original`
  return { hash, uri: `/image/${hash}`, r2_key: mode === 'shadow' ? `shadow/${base}` : base }
}

function metadataFromDetail(detail: MediaSubject, checkedAt: number) {
  return {
    exists: true,
    nsfw: detail.nsfw === true,
    checked_at: Math.floor(checkedAt / 1000),
    expires_at: null,
    reason: 'subject_detail' as const,
  }
}

function metadataFromNotFound(checkedAt: number) {
  return {
    exists: false,
    nsfw: true,
    checked_at: Math.floor(checkedAt / 1000),
    expires_at: Math.floor((checkedAt + TOMBSTONE_MS) / 1000),
    reason: 'not_found' as const,
  }
}

function copyRefs(refs: MediaImageRefs | null | undefined): MediaImageRefs {
  return {
    common: refs?.common ?? null,
    large: refs?.large ?? null,
  }
}

function changedSubjectCanBypassRetry(candidate: MediaCandidate, current: MediaState | null): boolean {
  if (candidate.priority !== 'new_or_changed' || !current || current.deletedAt !== null) return false
  return current.status.detail === 'success'
    && current.status.metadata === 'success'
    && (current.status.image === 'success' || current.status.image === 'missing')
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value.startsWith('//') ? `https:${value}` : value)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !IMAGE_HOSTS.has(parsed.hostname)) {
    throw new Error('MEDIA_URL_INVALID')
  }
  return parsed.href
}

async function readImage(response: Response): Promise<{ bytes: Uint8Array; contentType: string }> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  const header = response.headers.get('content-length')
  const declaredSize = header === null ? null : Number(header)
  if (response.status !== 200 || !IMAGE_TYPES.has(contentType) || !response.body
    || (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > MAX_IMAGE_BYTES))) {
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
      if (size > MAX_IMAGE_BYTES) throw new Error('MEDIA_IMAGE_TOO_LARGE')
      chunks.push(part.value)
    }
    if (size === 0) throw new Error('MEDIA_IMAGE_EMPTY')
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, contentType }
  } finally {
    try { await reader.cancel() } finally { reader.releaseLock() }
  }
}

function nextRefreshAt(subjectId: number, now: number): string {
  const spreadSeconds = Math.abs(Math.trunc(subjectId) * 997) % (2 * 86_400 + 1)
  return new Date(now + 6 * DAY_MS + spreadSeconds * 1_000).toISOString()
}

export async function refreshMedia(deps: MediaDependencies, context: RunContext): Promise<MediaSummary> {
  const now = timestamp(context.observedAt)
  if (now === null) throw new Error('INVALID_MEDIA_CONTEXT')
  const merged = new Map<number, MediaCandidate>()
  for (const candidate of await deps.list(context)) {
    const previous = merged.get(candidate.subjectId)
    if (!previous || PRIORITY[candidate.priority] < PRIORITY[previous.priority]) merged.set(candidate.subjectId, candidate)
  }
  const candidates = [...merged.values()]
    .sort((left, right) => PRIORITY[left.priority] - PRIORITY[right.priority] || left.subjectId - right.subjectId)
    .filter((candidate) => candidate.priority !== 'cold' || Math.abs(candidate.subjectId) % 7 === new Date(now).getUTCDay())
  const summary: MediaSummary = { selected: candidates.length, succeeded: 0, failed: 0 }
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++]!
      try {
        const failed = await deps.withSubject(candidate.subjectId, (session) => refreshSubject(deps, context, candidate, session))
        if (failed === true) summary.failed++
        else if (failed === false) summary.succeeded++
      } catch {
        summary.failed++
      }
    }
  }))
  return summary
}

async function refreshSubject(
  deps: MediaDependencies,
  context: RunContext,
  candidate: MediaCandidate,
  session: SubjectSession,
): Promise<boolean | undefined> {
  const now = timestamp(context.observedAt)
  if (now === null) throw new Error('INVALID_MEDIA_CONTEXT')
  const current = session.current
  const observed = timestamp(current?.observedAt)
  const retryAt = timestamp(current?.nextRetryAt)
  const currentFenceIsNewer = observed !== null && (observed > now
    || (observed === now && current?.runId !== null && current?.runId !== undefined && current.runId >= context.runId))
  if (currentFenceIsNewer
    || (retryAt !== null && retryAt > now && !changedSubjectCanBypassRetry(candidate, current))) return undefined

  const previousRefs = copyRefs(current?.imageRefs)
  const result: MediaResultInput = {
    subjectId: candidate.subjectId,
    runId: context.runId,
    observedAt: context.observedAt,
    detail: current?.detail ?? null,
    metadata: current?.metadata ?? null,
    imageRefs: previousRefs,
    detailHash: current?.detailHash ?? null,
    metadataHash: current?.metadataHash ?? null,
    imageHash: current?.imageHash ?? null,
    status: {},
    nextRetryAt: null,
    deletedAt: current?.deletedAt ?? null,
    lastSuccessAt: current?.lastSuccessAt ?? null,
  }
  let failed = false
  try {
    const detail = await deps.detail(candidate.subjectId)
    if (detail === null) {
      const metadata = metadataFromNotFound(now)
      result.metadata = metadata
      result.metadataHash = digest(JSON.stringify(metadata))
      result.status = { detail: 'not_found', metadata: 'success', image: 'not_found' }
      result.nextRetryAt = new Date(now + TOMBSTONE_MS).toISOString()
      result.deletedAt = context.observedAt
      await session.save(result)
      return false
    }
    if (detail.id !== candidate.subjectId || typeof detail.name !== 'string') throw new Error('MEDIA_DETAIL_CONTRACT')
    result.detail = {
      id: detail.id,
      name: detail.name,
      ...(detail.type === undefined ? {} : { type: detail.type }),
      ...(detail.name_cn === undefined ? {} : { name_cn: detail.name_cn }),
      ...(detail.summary === undefined ? {} : { summary: detail.summary }),
      ...(detail.nsfw === undefined ? {} : { nsfw: detail.nsfw }),
      ...(detail.date === undefined ? {} : { date: detail.date }),
      ...(detail.eps === undefined ? {} : { eps: detail.eps }),
      ...(detail.total_episodes === undefined ? {} : { total_episodes: detail.total_episodes }),
    }
    const metadata = metadataFromDetail(detail, now)
    result.metadata = metadata
    result.detailHash = digest(JSON.stringify(result.detail))
    result.metadataHash = digest(JSON.stringify(metadata))
    result.status = { detail: 'success', metadata: 'success', image: 'missing' }
    let present = 0
    const uploaded = new Set<string>()
    for (const size of ['common', 'large'] as const) {
      const source = detail.images?.[size]
      if (!source) continue
      present++
      try {
        const normalized = normalizeUrl(source)
        const { bytes, contentType } = await readImage(await deps.image(normalized))
        const hash = digest(bytes)
        const reference = imageReference(hash, context.mode)
        const reusable = Object.values(previousRefs).some((old) => old?.hash === hash && old.r2_key === reference.r2_key)
        if (!reusable && !uploaded.has(reference.r2_key)) {
          await deps.put(reference.r2_key, bytes, contentType)
          uploaded.add(reference.r2_key)
        }
        result.imageRefs = { ...result.imageRefs!, [size]: reference }
      } catch {
        failed = true
      }
    }
    result.status = { ...result.status, image: failed ? 'failed' : present ? 'success' : 'missing' }
    result.imageHash = digest(JSON.stringify(result.imageRefs))
    if (!failed) result.lastSuccessAt = context.observedAt
    result.nextRetryAt = nextRefreshAt(candidate.subjectId, now)
  } catch {
    failed = true
    result.status = { detail: 'failed', metadata: 'failed', image: 'failed' }
    result.nextRetryAt = new Date(now + RETRY_MS).toISOString()
  }
  await session.save(result)
  return failed
}
