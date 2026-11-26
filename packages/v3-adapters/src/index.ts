import { CloudflareRuntimeAdapter } from './cloudflare.ts'
import { PortableRuntimeAdapter } from './portable.ts'
import { normalizeRuntimePlatformId, resolveRuntimePlatformIdFromEnv } from './platform-id.ts'
import type { RuntimeAdapter } from '@airing-cal/v3-core/ports'

export { PortableRuntimeAdapter } from './portable.ts'
export { CloudflareRuntimeAdapter } from './cloudflare.ts'
export {
  CloudflareR2PublicStore,
  type CloudflareR2BucketBinding,
} from './cloudflare-r2-public-store.ts'
export { HttpPublicStore, type HttpPublicStoreOptions } from './http-public-store.ts'
export {
  normalizeRuntimePlatformId,
  resolveRuntimePlatformIdFromEnv,
  type RuntimePlatformId,
} from './platform-id.ts'

export function resolveRuntimeAdapter(platformId: string): RuntimeAdapter {
  const resolved = normalizeRuntimePlatformId(platformId)
  switch (resolved) {
    case 'portable':
      return new PortableRuntimeAdapter()
    case 'cloudflare':
      return new CloudflareRuntimeAdapter()
    default: {
      const unsupported: never = resolved
      throw new Error(`No runtime adapter for platform_id: ${unsupported}`)
    }
  }
}

export function resolveRuntimeAdapterFromEnv(env: Record<string, string | undefined> = process.env) {
  return resolveRuntimeAdapter(resolveRuntimePlatformIdFromEnv(env))
}
