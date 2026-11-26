import { imageOriginalKey, imageThumbV1Key, imageThumbV2Key, sniffImage } from '@airing-cal/storage'
import { PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core/public-pointer'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'
import type { PublicStore } from '@airing-cal/v3-core/ports'

/**
 * Controlled public object interface (owner target contract §6.3, #72
 * private-R2 convergence). With the bucket private, compatible readers
 * (EdgeOne/Netlify adapters, the ship verifier) consume exactly these
 * allowlisted public release keys through the Worker instead of a bucket
 * custom domain. Every other key — `checkpoints/**`, foreign prefixes,
 * traversal, encoding variants — matches nothing here and falls through to
 * 404 before any store read. Keys are built from regex-captured hex/digits
 * only, never from raw path passthrough.
 */

const POINTER_PATH = '/public/current-release.json'
const LEGACY_MANIFEST_PATH = '/public/manifest.json'
const SNAPSHOT_PATH = /^\/snapshots\/v1\/(0|[1-9]\d*)-([0-9a-f]{64})\.json$/
const MANIFEST_PATH = /^\/public\/manifests\/(0|[1-9]\d*)-([0-9a-f]{64})\.json$/
const IMAGE_ORIGINAL_PATH = /^\/images\/([0-9a-f]{64})\/original$/
const IMAGE_THUMB_V1_PATH = /^\/images\/([0-9a-f]{64})\/thumb\.v1\.webp$/
const IMAGE_THUMB_V2_PATH = /^\/images\/([0-9a-f]{64})\/thumb\.v2\.webp$/

interface PublicObjectRoute {
  key: string
  /** `immutable` keys are content-addressed and cacheable for a year. */
  cacheControl: string
  contentType: string
  /** Originals are content-sniffed; the declared type is the fallback. */
  sniff?: boolean
}

export function matchPublicObjectPath(pathname: string): PublicObjectRoute | null {
  if (pathname === POINTER_PATH) {
    return { key: PUBLIC_RELEASE_POINTER_KEY, cacheControl: V2_CACHE_CONTROL.defaultJson, contentType: 'application/json' }
  }
  if (pathname === LEGACY_MANIFEST_PATH) {
    return { key: 'public/manifest.json', cacheControl: V2_CACHE_CONTROL.defaultJson, contentType: 'application/json' }
  }
  const snapshot = SNAPSHOT_PATH.exec(pathname)
  if (snapshot?.[1] && snapshot[2]) {
    return {
      key: imageSnapshotKey(snapshot[1], snapshot[2]),
      cacheControl: V2_CACHE_CONTROL.image,
      contentType: 'application/json',
    }
  }
  const manifest = MANIFEST_PATH.exec(pathname)
  if (manifest?.[1] && manifest[2]) {
    return {
      key: `public/manifests/${manifest[1]}-${manifest[2]}.json`,
      cacheControl: V2_CACHE_CONTROL.image,
      contentType: 'application/json',
    }
  }
  const original = IMAGE_ORIGINAL_PATH.exec(pathname)
  if (original?.[1]) {
    return { key: imageOriginalKey(original[1]), cacheControl: V2_CACHE_CONTROL.image, contentType: 'application/octet-stream', sniff: true }
  }
  const thumbV2 = IMAGE_THUMB_V2_PATH.exec(pathname)
  if (thumbV2?.[1]) {
    return { key: imageThumbV2Key(thumbV2[1]), cacheControl: V2_CACHE_CONTROL.image, contentType: 'image/webp' }
  }
  const thumbV1 = IMAGE_THUMB_V1_PATH.exec(pathname)
  if (thumbV1?.[1]) {
    return { key: imageThumbV1Key(thumbV1[1]), cacheControl: V2_CACHE_CONTROL.image, contentType: 'image/webp' }
  }
  return null
}

function imageSnapshotKey(generation: string, hash: string): string {
  return `snapshots/v1/${generation}-${hash}.json`
}

export function isPublicObjectPath(pathname: string): boolean {
  return matchPublicObjectPath(pathname) !== null
}

/** Serves one allowlisted public release object, or 404 when absent. */
export async function handlePublicObject(pathname: string, publicStore: PublicStore): Promise<Response> {
  const route = matchPublicObjectPath(pathname)
  if (!route) return new Response('Not found', { status: 404, headers: { 'Cache-Control': V2_CACHE_CONTROL.error } })
  const bytes = await publicStore.getSnapshotBytes(route.key)
  if (!bytes) return new Response('Not found', { status: 404, headers: { 'Cache-Control': V2_CACHE_CONTROL.error } })
  let contentType = route.contentType
  if (route.sniff) {
    const stored = await publicStore.headObject?.(route.key)
    const storedType = stored?.contentType?.trim() ?? ''
    contentType = storedType.toLowerCase().startsWith('image/')
      ? storedType
      : (sniffImage(bytes) ?? contentType)
  }
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': route.cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
