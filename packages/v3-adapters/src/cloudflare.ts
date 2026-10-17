import type { PublisherCapabilities, RuntimeAdapter } from '@airing-cal/v3-core'

/** Cloudflare Workers + R2 (#72). Pointer CAS via {@link CloudflareR2PublicStore}; staging smoke still required. */
export class CloudflareRuntimeAdapter implements RuntimeAdapter {
  readonly platform_id = 'cloudflare'

  capabilities(): PublisherCapabilities {
    return {
      compare_and_swap_pointer: true,
      immutable_object_store: true,
      serve_static_assets: true,
      serve_read_gateway: true,
    }
  }
}
