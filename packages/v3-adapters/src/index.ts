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
