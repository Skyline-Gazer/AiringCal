export const thumbGenBoundary = 'web-worker-thumb-gen'

import {
  materializeThumb,
  MAX_THUMB_BATCH,
  summarizeThumbResults,
  type ThumbGenItemResult,
  type ThumbMaterializeEnv,
} from './thumb-materialize.ts'

const HASH_PATTERN = /^[0-9a-f]{64}$/i

export interface ThumbGenEnv extends ThumbMaterializeEnv {
  THUMB_GEN_BEARER?: string
}

export type { ThumbGenItemResult, ThumbGenItemStatus } from './thumb-materialize.ts'

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'Cache-Control': 'no-store',
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers as Record<string, string> | undefined),
    },
  })
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)
  return token.length > 0 ? token : null
}

function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean
  }
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(left, right)
  }
  const root = crypto as Crypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean
  }
  if (typeof root.timingSafeEqual === 'function') {
    return root.timingSafeEqual(left, right)
  }
  let mismatch = 0
  for (let index = 0; index < left.byteLength; index++) {
    mismatch |= left[index]! ^ right[index]!
  }
  return mismatch === 0
}

function timingSafeEqualString(a: string, b: string): boolean {
  const enc = new TextEncoder()
  return timingSafeEqualBytes(enc.encode(a), enc.encode(b))
}

export function authorizeThumbGen(request: Request, env: Pick<ThumbGenEnv, 'THUMB_GEN_BEARER'>): boolean {
  const expected = env.THUMB_GEN_BEARER?.trim()
  if (!expected) return false
  const token = bearerToken(request)
  if (token === null) return false
  return timingSafeEqualString(token, expected)
}

function normalizeHashes(raw: unknown): string[] | null {
  if (!raw || typeof raw !== 'object' || !('large_hashes' in raw)) return null
  const list = (raw as { large_hashes?: unknown }).large_hashes
  if (!Array.isArray(list)) return null
  const hashes: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string' || !HASH_PATTERN.test(entry)) return null
    hashes.push(entry.toLowerCase())
  }
  return [...new Set(hashes)]
}

export async function handleThumbGenRequest(request: Request, env: ThumbGenEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { 'Cache-Control': 'no-store' } })
  }
  if (!authorizeThumbGen(request, env)) {
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or missing Bearer token' } }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: { code: 'INVALID_BODY', message: 'Expected JSON body' } }, { status: 400 })
  }

  const hashes = normalizeHashes(body)
  if (hashes === null) {
    return json({ ok: false, error: { code: 'INVALID_BODY', message: 'Body must be { "large_hashes": ["<sha256>", ...] }' } }, { status: 400 })
  }
  if (hashes.length > MAX_THUMB_BATCH) {
    return json({ ok: false, error: { code: 'BATCH_TOO_LARGE', message: `At most ${MAX_THUMB_BATCH} hashes per request` } }, { status: 400 })
  }

  const results: ThumbGenItemResult[] = []
  for (const hash of hashes) {
    results.push(await materializeThumb(hash, env))
  }

  return json({ ok: true, results, summary: summarizeThumbResults(results) }, { status: 202 })
}
