import { imageOriginalKey, imageThumbV2Key } from '@airing-cal/storage'

export type PublicImageVariant = 'original' | 'thumb'

export function normalizePublicBaseUrl(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.replace(/\/+$/, '')
}

export function publicImageObjectKey(hash: string, variant: PublicImageVariant): string {
  const normalized = hash.trim().toLowerCase()
  return variant === 'thumb' ? imageThumbV2Key(normalized) : imageOriginalKey(normalized)
}

/** Absolute public CDN/S3 URL for an image object, or null when base is unset. */
export function resolvePublicImageRedirect(
  publicBaseUrl: string | null | undefined,
  hash: string,
  variant: PublicImageVariant,
): string | null {
  const base = normalizePublicBaseUrl(publicBaseUrl ?? null)
  if (!base) return null
  return `${base}/${publicImageObjectKey(hash, variant)}`
}

export function publicImageRedirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'public, max-age=300',
    },
  })
}
