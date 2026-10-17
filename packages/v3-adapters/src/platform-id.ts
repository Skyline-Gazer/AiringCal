export type RuntimePlatformId = 'portable' | 'cloudflare' | 'edgeone'

const RUNTIME_PLATFORM_ALIASES: Record<string, RuntimePlatformId> = {
  portable: 'portable',
  docker: 'portable',
  cloudflare: 'cloudflare',
  cf: 'cloudflare',
  edgeone: 'edgeone',
  'tencent-edgeone': 'edgeone',
}

/**
 * Runtime-neutral platform id resolution. Kept free of `node:` imports so
 * Workers read gateways can label `/api/version` without bundling the
 * adapter registry's config/CLI dependencies.
 */
export function normalizeRuntimePlatformId(platformId: string): RuntimePlatformId {
  const id = platformId.trim().toLowerCase()
  const resolved = RUNTIME_PLATFORM_ALIASES[id]
  if (!resolved) throw new Error(`Unknown platform_id: ${platformId}`)
  return resolved
}

export function resolveRuntimePlatformIdFromEnv(
  env: Record<string, string | undefined>,
): RuntimePlatformId {
  const explicit = env.AIRINGCAL_PLATFORM?.trim() || env.AIRINGCAL_RUNTIME?.trim()
  const inferred = (env.AIRINGCAL_BUILDER?.trim().toLowerCase() ?? '') === 'portable' ? 'portable' : ''
  const platformId = explicit || inferred
  if (!platformId) {
    throw new Error('AIRINGCAL_PLATFORM, AIRINGCAL_RUNTIME, or AIRINGCAL_BUILDER=portable is required')
  }
  return normalizeRuntimePlatformId(platformId)
}
