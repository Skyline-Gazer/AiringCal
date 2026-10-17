import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'
import sharp from 'sharp'
import type { R2Store } from '../adapters/r2-store.ts'

/** Matches web-worker `THUMB_TRANSFORM_V2` / THUMB_SPEC v2. */
export const PORTABLE_THUMB_V2 = {
  width: 320,
  height: 427,
  quality: 78,
} as const

export interface PortableThumbSummary {
  generated: number
  skipped: number
  missing_original: number
  error: number
}

export async function materializePortableThumbs(
  hashes: string[],
  store: R2Store,
): Promise<PortableThumbSummary> {
  const summary: PortableThumbSummary = {
    generated: 0,
    skipped: 0,
    missing_original: 0,
    error: 0,
  }
  for (const raw of hashes) {
    const hash = raw.toLowerCase()
    const thumbKey = imageThumbV2Key(hash)
    if (await store.get(thumbKey, 512 * 1024)) {
      summary.skipped += 1
      continue
    }
    const original = await store.get(imageOriginalKey(hash), 8 * 1024 * 1024)
    if (!original) {
      summary.missing_original += 1
      continue
    }
    try {
      const thumbBytes = await sharp(original)
        .resize(PORTABLE_THUMB_V2.width, PORTABLE_THUMB_V2.height, { fit: 'cover' })
        .webp({ quality: PORTABLE_THUMB_V2.quality })
        .toBuffer()
      await store.put(thumbKey, new Uint8Array(thumbBytes), 'image/webp')
      summary.generated += 1
    } catch {
      summary.error += 1
    }
  }
  return summary
}
