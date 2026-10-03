import { parsePublicSnapshotV1, snapshotObjectKey } from '@airing-cal/domain'

export interface SnapshotBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>
}
export interface SnapshotCache {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export async function snapshotResponse(
  key: string, bucket: SnapshotBucket, cache: SnapshotCache, origin: string,
): Promise<Response> {
  if (!/^snapshots\/v1\/(0|[1-9][0-9]*)-[0-9a-f]{64}\.json$/.test(key)) {
    return new Response('Invalid snapshot key', { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const cacheKey = new Request(new URL(`/api/${key}`, origin))
  try {
    const cached = await cache.match(cacheKey)
    if (cached?.ok) return cached
  } catch { /* Cache availability must not block a valid R2 read. */ }

  const object = await bucket.get(key)
  if (!object) return new Response('Snapshot not found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
  const snapshot = await parsePublicSnapshotV1(JSON.parse(await object.text()))
  if (snapshotObjectKey(snapshot) !== key) throw new Error('Snapshot identity mismatch')
  const response = Response.json(snapshot, {
    headers: {
      'Cache-Control': 'public, max-age=2592000, immutable',
      'ETag': `"${snapshot.generation}-${snapshot.content_hash}"`,
      'X-Content-Type-Options': 'nosniff',
    },
  })
  try { await cache.put(cacheKey, response.clone()) } catch { /* Best effort edge cache. */ }
  return response
}
