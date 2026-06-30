export const packageBoundary = '@airing-cal/bgm-api'

export { BgmClient, BgmHttpError, BgmTimeoutError, BgmNetworkError } from './bgm-client.ts'
export type {
  BgmCalendarItem,
  BgmCollection,
  BgmEpisodeCollection,
  BgmSlimSubject,
  TokenStatus,
} from './bgm-client.ts'
export { fetchAllCollections } from './utils.ts'
