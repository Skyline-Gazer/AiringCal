export interface CollectionContentInput {
  user_id: string
  subject_id: number
  subject_type: number
  collection_type: number
  rate?: number | null
  tags?: string[]
  tags_json?: string
  comment?: string
  ep_status: number
  vol_status: number
  subject?: unknown
  subject_json?: string
  [runtimeField: string]: unknown
}

interface SubjectBusinessProjection {
  id: unknown
  type: unknown
  name: unknown
  name_cn: unknown
  summary: unknown
  date: unknown
  eps: unknown
  total_episodes: unknown
  nsfw: unknown
  images: {
    common: unknown
    large: unknown
  } | null
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number')
    return value
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(canonicalize)

  if (typeof value === 'object') {
    if (!isPlainObject(value)) throw new TypeError('Canonical JSON only supports plain objects')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }

  throw new TypeError(`Cannot canonicalize ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function parseJsonOr<T>(value: string | undefined, fallback: T): unknown {
  if (value === undefined) return fallback
  return JSON.parse(value) as unknown
}

function subjectBusinessProjection(value: unknown): SubjectBusinessProjection | null {
  if (!isPlainObjectValue(value)) return null
  const images = isPlainObjectValue(value.images)
    ? {
        common: value.images.common ?? null,
        large: value.images.large ?? null,
      }
    : null
  return {
    id: value.id ?? null,
    type: value.type ?? null,
    name: value.name ?? null,
    name_cn: value.name_cn ?? null,
    summary: value.summary ?? null,
    date: value.date ?? null,
    eps: value.eps ?? null,
    total_episodes: value.total_episodes ?? null,
    nsfw: value.nsfw ?? null,
    images,
  }
}

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && isPlainObject(value)
}

export async function collectionContentHash(input: CollectionContentInput): Promise<string> {
  const subject = input.subject === undefined
    ? parseJsonOr(input.subject_json, null)
    : input.subject
  return sha256Canonical({
    user_id: input.user_id,
    subject_id: input.subject_id,
    subject_type: input.subject_type,
    collection_type: input.collection_type,
    rate: input.rate ?? null,
    tags: input.tags ?? parseJsonOr(input.tags_json, []),
    comment: input.comment ?? '',
    ep_status: input.ep_status,
    vol_status: input.vol_status,
    upstream_updated_at: input.upstream_updated_at ?? null,
    subject: subjectBusinessProjection(subject),
  })
}
