import type { PublisherCapabilities, RuntimeAdapter } from '@airing-cal/v3-core'

/** Placeholder (#72): EdgeOne Pages / object storage; verification backlog in #69. */
export class EdgeOneRuntimeAdapter implements RuntimeAdapter {
  readonly platform_id = 'edgeone'

  capabilities(): PublisherCapabilities {
    return {
      compare_and_swap_pointer: false,
      immutable_object_store: true,
      serve_static_assets: true,
      serve_read_gateway: true,
    }
  }
}
