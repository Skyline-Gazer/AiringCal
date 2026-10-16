/**
 * Observable v2 public read surface (web-worker). Values must match
 * apps/web-worker/src/read-api.ts and docs/reference/web-worker-public-api.md.
 */

export const V2_PUBLIC_READ_ROUTES = [
  'GET /api/collections',
  'GET /api/calendar',
  'GET /api/config',
  'GET /api/health',
  'GET /api/version',
  'GET /api/cache',
  'GET /image/:hash',
  'GET /image/:hash/thumb',
] as const

export const V2_STATIC_ASSET_ROUTES = [
  'GET /',
  'GET /src/bangumi.js',
  'GET /src/bangumi.css',
  'GET /src/cache.js',
] as const

export const V2_RETIRED_ROUTES = [
  'GET /api/sync/compare',
  'GET /api/sync/apply',
  'GET /api/check/*',
] as const

export const V2_CACHE_CONTROL = {
  collections: 'public, max-age=30, s-maxage=300, stale-while-revalidate=120',
  calendar: 'public, max-age=60, s-maxage=600, stale-while-revalidate=300',
  config: 'public, max-age=60',
  version: 'public, max-age=60',
  defaultJson: 'public, max-age=60',
  image: 'public, max-age=31536000, immutable',
  imageCdn: 'max-age=31536000',
  error: 'no-store',
} as const

export type V2ReadRoute = (typeof V2_PUBLIC_READ_ROUTES)[number]
