import type { PublisherCapabilities, RuntimeAdapter } from '@airing-cal/v3-core'

export class PortableRuntimeAdapter implements RuntimeAdapter {
  readonly platform_id = 'portable'

  capabilities(): PublisherCapabilities {
    return {
      compare_and_swap_pointer: true,
      immutable_object_store: true,
      serve_static_assets: true,
      serve_read_gateway: true,
    }
  }
}
