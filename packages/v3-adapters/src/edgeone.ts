import type { PublisherCapabilities, RuntimeAdapter } from '@airing-cal/v3-core'

/** EdgeOne Makers Blob read store (#72): {@link EdgeOnePublicStore}; real staging still a #69 backlog item. */
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
