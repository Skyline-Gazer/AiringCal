import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { SubjectMediaPublishHint } from './media-hints.ts'

const IMAGE_HOSTS = new Set(['lain.bgm.tv', 'lain.bangumi.tv'])

type BangumiImageSizes = {
  common?: string
  large?: string
  medium?: string
  small?: string
  grid?: string
}

function bangumiImageUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null
  const href = value.trim().startsWith('//') ? `https:${value.trim()}` : value.trim()
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (!IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null
  if (url.protocol === 'http:') {
    url = new URL(url.href.replace(/^http:/i, 'https:'))
  } else if (url.protocol !== 'https:') {
    return null
  }
  return url.href
}

function coalesceSubjectImageUrls(images: BangumiImageSizes | undefined): { common?: string; large?: string } {
  if (!images) return {}
  const common = images.common || images.medium || images.small || images.grid
  const large = images.large || images.common || images.medium
  return {
    ...(typeof common === 'string' && common ? { common } : {}),
    ...(typeof large === 'string' && large ? { large } : {}),
  }
}

function hintFromImages(images: BangumiImageSizes | undefined): SubjectMediaPublishHint {
  const coalesced = coalesceSubjectImageUrls(images)
  return {
    errorCode: null,
    hasSourceCommon: Boolean(bangumiImageUrl(coalesced.common)),
    hasSourceLarge: Boolean(bangumiImageUrl(images?.large)),
  }
}

/** Source URL presence for public snapshot `image_status` when no cached image map exists yet. */
export function mediaPublishHintsFromFetch(input: CompleteFullFetch): Map<number, SubjectMediaPublishHint> {
  const hints = new Map<number, SubjectMediaPublishHint>()

  const merge = (subjectId: number, images: BangumiImageSizes | undefined, pub: boolean) => {
    if (!pub || !Number.isSafeInteger(subjectId) || subjectId <= 0) return
    const next = hintFromImages(images)
    const prev = hints.get(subjectId)
    if (!prev) {
      hints.set(subjectId, next)
      return
    }
    hints.set(subjectId, {
      errorCode: prev.errorCode ?? next.errorCode,
      hasSourceCommon: prev.hasSourceCommon || next.hasSourceCommon,
      hasSourceLarge: prev.hasSourceLarge || next.hasSourceLarge,
    })
  }

  for (const entry of input.collections) {
    merge(
      entry.collection.subject_id,
      entry.collection.subject?.images,
      entry.collection.private !== true,
    )
  }
  for (const day of input.calendar) {
    for (const item of day.items) {
      merge(item.id, item.images, true)
    }
  }

  return hints
}
