import type { PublisherCapabilities, RuntimeAdapter } from '@airing-cal/v3-core'

/** Placeholder (#72): Workers + R2 + KV read path; not wired in v3.0.0-alpha. */
export class CloudflareRuntimeAdapter implements RuntimeAdapter {
  readonly platform_id = 'cloudflare'

  capabilities(): PublisherCapabilities {
    return {
      compare_and_swap_pointer: false,
      immutable_object_store: true,
      serve_static_assets: true,
      serve_read_gateway: true,
    }
  }
}
