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

export class InvalidPublicBaseUrlError extends Error {
  readonly code = 'INVALID_PUBLIC_BASE_URL'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidPublicBaseUrlError'
  }
}

export interface PublicBaseUrlOptions {
  /**
   * Accept `http://` on loopback hosts only. Only for local adapters/test doubles
   * (MinIO-style fetch); every deployed read surface requires https.
   */
  allowInsecure?: boolean
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'] as const

/**
 * Validates the operator-supplied `AIRINGCAL_PUBLIC_BASE_URL` (C6).
 *
 * Absolute https is required, and placeholder hosts such as
 * `https://PLACEHOLDER_PUBLIC_CDN` are rejected instead of being deployed as a
 * redirect target. Returns the normalized base (no trailing slash) or `null`
 * when unset.
 */
export function parsePublicBaseUrl(
  value: string | null | undefined,
  options: PublicBaseUrlOptions = {},
): string | null {
  const normalized = normalizePublicBaseUrl(value)
  if (!normalized) return null
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new InvalidPublicBaseUrlError(
      `AIRINGCAL_PUBLIC_BASE_URL must be an absolute https URL (got "${value}")`,
    )
  }
  const loopbackHttp = options.allowInsecure === true
    && url.protocol === 'http:'
    && LOOPBACK_HOSTS.includes(url.hostname as (typeof LOOPBACK_HOSTS)[number])
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw new InvalidPublicBaseUrlError(
      `AIRINGCAL_PUBLIC_BASE_URL must use https (got "${value}")`,
    )
  }
  if (/placeholder/i.test(normalized)) {
    throw new InvalidPublicBaseUrlError(
      `AIRINGCAL_PUBLIC_BASE_URL is a placeholder value ("${value}"); configure the verified public CDN host`,
    )
  }
  if (url.search !== '' || url.hash !== '') {
    throw new InvalidPublicBaseUrlError(
      `AIRINGCAL_PUBLIC_BASE_URL must not carry a query or fragment (got "${value}")`,
    )
  }
  return normalized
}

/**
 * Memoized {@link parsePublicBaseUrl} for Worker entries: the value is validated
 * once per isolate (first request = config validation) and reused afterwards, so
 * a bad deployment fails closed loudly without re-parsing on every request.
 */
export function createPublicBaseUrlValidator(): (
  value: string | null | undefined,
) => string | null {
  let primed = false
  let lastValue: string | null | undefined
  let lastResult: string | null = null
  return (value) => {
    if (primed && value === lastValue) return lastResult
    const result = parsePublicBaseUrl(value)
    primed = true
    lastValue = value
    lastResult = result
    return result
  }
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
