import { imageOriginalKey, imageThumbV1Key } from '@airing-cal/storage'
import type { ImageR2Binding, ThumbImagesBinding } from './image-r2-binding.ts'

/** THUMB_SPEC v1 — bump R2 suffix / transform when changing. */
export const THUMB_SPEC_REVISION = 'v1'

export const THUMB_TRANSFORM = {
  width: 420,
  height: 560,
  fit: 'cover' as const,
  format: 'image/webp' as const,
  quality: 85,
}

export const MAX_THUMB_BATCH = 50

const LARGE_ORIGINAL_KEY = /^images\/([0-9a-f]{64})\/original$/i

export interface ThumbMaterializeEnv {
  AIRING_CAL_R2: ImageR2Binding
  IMAGES: ThumbImagesBinding
}

export type ThumbGenItemStatus = 'skipped' | 'generated' | 'missing_original' | 'error'

export interface ThumbGenItemResult {
  hash: string
  status: ThumbGenItemStatus
  error?: string
}

function streamFromBytes(bytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes))
      controller.close()
    },
  })
}

export function hashFromLargeR2Key(key: string | null | undefined): string | null {
  if (!key) return null
  const match = LARGE_ORIGINAL_KEY.exec(key.trim())
  if (!match?.[1]) return null
  return match[1].toLowerCase()
}

export async function materializeThumb(hash: string, env: ThumbMaterializeEnv): Promise<ThumbGenItemResult> {
  const normalized = hash.toLowerCase()
  const thumbKey = imageThumbV1Key(normalized)
  const existing = await env.AIRING_CAL_R2.head(thumbKey)
  if (existing) {
    console.log(JSON.stringify({ stage: 'thumb_gen', hash: normalized, status: 'skipped', reason: 'exists' }))
    return { hash: normalized, status: 'skipped' }
  }

  const original = await env.AIRING_CAL_R2.get(imageOriginalKey(normalized))
  if (!original) {
    console.log(JSON.stringify({ stage: 'thumb_gen', hash: normalized, status: 'missing_original' }))
    return { hash: normalized, status: 'missing_original' }
  }

  try {
    const bytes = await original.arrayBuffer()
    const transformed = await env.IMAGES
      .input(streamFromBytes(bytes))
      .transform({ width: THUMB_TRANSFORM.width, height: THUMB_TRANSFORM.height, fit: THUMB_TRANSFORM.fit })
      .output({ format: THUMB_TRANSFORM.format, quality: THUMB_TRANSFORM.quality })
    const thumbBytes = await new Response(transformed.image()).arrayBuffer()
    await env.AIRING_CAL_R2.put(thumbKey, thumbBytes, {
      httpMetadata: { contentType: 'image/webp' },
    })
    console.log(JSON.stringify({ stage: 'thumb_gen', hash: normalized, status: 'generated', bytes: thumbBytes.byteLength }))
    return { hash: normalized, status: 'generated' }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'transform_failed'
    console.log(JSON.stringify({ stage: 'thumb_gen', hash: normalized, status: 'error', error: message }))
    return { hash: normalized, status: 'error', error: message }
  }
}

export function summarizeThumbResults(results: ThumbGenItemResult[]) {
  return {
    total: results.length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    generated: results.filter((item) => item.status === 'generated').length,
    missing_original: results.filter((item) => item.status === 'missing_original').length,
    error: results.filter((item) => item.status === 'error').length,
  }
}
