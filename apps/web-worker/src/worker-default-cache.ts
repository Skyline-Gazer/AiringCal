/** Cloudflare Workers `caches.default` (DOM lib typings omit `default`). */
export type WorkerDefaultCache = Pick<Cache, 'match' | 'put'>

export function workerDefaultCache(): WorkerDefaultCache | undefined {
  if (typeof caches === 'undefined') return undefined
  return (caches as CacheStorage & { readonly default: Cache }).default
}
