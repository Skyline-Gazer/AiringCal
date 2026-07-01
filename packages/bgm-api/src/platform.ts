import {
  type AccountInfo,
  type ComparisonItem,
  type PatchEntryOptions,
  type PatchEntryResult,
  type PlatformClient,
  type PlatformId,
  WatchStatus,
} from '@airing-cal/domain'
import { BgmClient, type BgmEpisodeCollection } from './bgm-client.ts'
import { fetchAllCollections } from './utils.ts'

const BGM_STATUS_MAP: Record<number, WatchStatus> = {
  1: WatchStatus.PLAN_TO_WATCH,
  2: WatchStatus.COMPLETED,
  3: WatchStatus.WATCHING,
  4: WatchStatus.ON_HOLD,
  5: WatchStatus.DROPPED,
}

const WATCH_STATUS_TO_BGM: Record<string, number> = {
  [WatchStatus.PLAN_TO_WATCH]: 1,
  [WatchStatus.COMPLETED]: 2,
  [WatchStatus.WATCHING]: 3,
  [WatchStatus.ON_HOLD]: 4,
  [WatchStatus.DROPPED]: 5,
}

type EpisodeCollectionType = BgmEpisodeCollection['type']

function episodeTypeMap(entries: Array<{ episode: { id: number }; type: EpisodeCollectionType }>): Map<number, EpisodeCollectionType> {
  return new Map(entries.map((entry) => [entry.episode.id, entry.type]))
}

export class BgmPlatformClient implements PlatformClient {
  readonly platform: PlatformId = 'bgm'

  async getMe(token: string): Promise<AccountInfo> {
    const client = new BgmClient()
    const me = await client.getMe(token)
    return { username: me.username, externalId: String(me.id), platform: 'bgm' }
  }

  async fetchCollections(token: string, username: string): Promise<ComparisonItem[]> {
    const collections = await fetchAllCollections(new BgmClient(token), username)
    return collections.map((collection) => ({
      externalId: String(collection.subject_id),
      title: collection.subject?.name_cn || collection.subject?.name || String(collection.subject_id),
      status: BGM_STATUS_MAP[collection.type] || WatchStatus.WATCHING,
      progress: collection.ep_status,
      totalEpisodes: collection.subject?.eps || collection.subject?.total_episodes || 0,
      score: collection.rate,
      platform: 'bgm',
    }))
  }

  async patchEntry(token: string, externalId: string, item: ComparisonItem, options?: PatchEntryOptions): Promise<PatchEntryResult> {
    const client = new BgmClient()
    const bgmType = WATCH_STATUS_TO_BGM[item.status] || WATCH_STATUS_TO_BGM[WatchStatus.WATCHING]
    await client.upsertCollection(token, Number(externalId), {
      type: bgmType,
      rate: item.score,
    })

    if (!options?.sourceToken) {
      return {
        episodeChanged: 0,
        episodeProgress: {
          before: item.progress,
          after: item.progress,
          total: item.totalEpisodes,
        },
      }
    }

    return this.syncEpisodeProgress(client, options.sourceToken, token, Number(externalId), item.totalEpisodes)
  }

  private async syncEpisodeProgress(client: BgmClient, sourceToken: string, targetToken: string, subjectId: number, totalEpisodes: number): Promise<PatchEntryResult> {
    const [source, target] = await Promise.all([
      client.getSubjectEpisodeCollections(sourceToken, subjectId),
      client.getSubjectEpisodeCollections(targetToken, subjectId),
    ])
    const sourceMap = episodeTypeMap(source.data)
    const targetMap = episodeTypeMap(target.data)
    const before = [...targetMap.values()].filter((type) => type === 2).length
    const after = [...sourceMap.values()].filter((type) => type === 2).length
    const total = totalEpisodes || Math.max(sourceMap.size, targetMap.size)
    const changedByType = new Map<EpisodeCollectionType, number[]>()
    const episodeIds = new Set([...sourceMap.keys(), ...targetMap.keys()])

    for (const episodeId of episodeIds) {
      const sourceType = sourceMap.get(episodeId) ?? 0
      const targetType = targetMap.get(episodeId) ?? 0
      if (sourceType === targetType) continue
      const bucket = changedByType.get(sourceType) ?? []
      bucket.push(episodeId)
      changedByType.set(sourceType, bucket)
    }

    let changed = 0
    for (const [type, ids] of changedByType) {
      if (!ids.length) continue
      await client.patchSubjectEpisodeCollections(targetToken, subjectId, ids, type)
      changed += ids.length
    }

    return { episodeChanged: changed, episodeProgress: { before, after, total } }
  }
}
