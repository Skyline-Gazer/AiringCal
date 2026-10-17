import { CloudflareRuntimeAdapter } from './cloudflare.ts'
import { EdgeOneRuntimeAdapter } from './edgeone.ts'
import { PortableRuntimeAdapter } from './portable.ts'

export { PortableRuntimeAdapter } from './portable.ts'
export { CloudflareRuntimeAdapter } from './cloudflare.ts'
export { EdgeOneRuntimeAdapter } from './edgeone.ts'

export function resolveRuntimeAdapter(platformId: string) {
  const id = platformId.trim().toLowerCase()
  if (id === 'portable' || id === 'docker') return new PortableRuntimeAdapter()
  if (id === 'cloudflare' || id === 'cf') return new CloudflareRuntimeAdapter()
  if (id === 'edgeone' || id === 'tencent-edgeone') return new EdgeOneRuntimeAdapter()
  throw new Error(`Unknown platform_id: ${platformId}`)
}

export {
  parseAiringcalConfig,
  portableEnvFromAiringcalConfig,
  type AiringcalConfigV1,
  type AiringcalPlatform,
} from './airingcal-config.ts'

export function resolveRuntimeAdapterFromEnv(env: Record<string, string | undefined> = process.env) {
  const explicit = env.AIRINGCAL_PLATFORM?.trim() || env.AIRINGCAL_RUNTIME?.trim()
  const inferred = (env.AIRINGCAL_BUILDER?.trim().toLowerCase() ?? '') === 'portable' ? 'portable' : ''
  const platformId = explicit || inferred
  if (!platformId) {
    throw new Error('AIRINGCAL_PLATFORM, AIRINGCAL_RUNTIME, or AIRINGCAL_BUILDER=portable is required')
  }
  return resolveRuntimeAdapter(platformId)
}
