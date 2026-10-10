export const packageBoundary = '@airing-cal/bgm-api'

export { BgmClient, BgmHttpError, BgmTimeoutError, BgmNetworkError, BgmPaginationError } from './bgm-client.ts'
export { BgmEpisodePatchError, BgmPlatformClient } from './platform.ts'
export type {
  BgmCalendarItem,
  BgmCollection,
  BgmEpisodeCollection,
  BgmSlimSubject,
  TokenStatus,
} from './bgm-client.ts'
export { fetchAllCollections } from './utils.ts'
export { assembleFullFetch } from './full-fetch-boundary.ts'
export type { CollectionFetchGroup, CollectionFetchPage, CompleteFullFetch } from './full-fetch-boundary.ts'
