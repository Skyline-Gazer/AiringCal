export const appBoundary = 'sync-worker'

import { BgmClient, fetchAllCollections } from '@airing-cal/bgm-api'
import { mergeCollections } from '@airing-cal/domain'
import { KVStorage, snapshotCalendarKey, snapshotCollectionsKey, snapshotSummaryKey, syncMetaKey } from '@airing-cal/storage'

interface SyncEnv {
  AIRING_CAL_KV: {
    get(key: string, type: 'json'): Promise<unknown>
    put(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  MEDIA_QUEUE: { send(message: unknown): Promise<void> }
  BANGUMI_TOKEN: string
  BANGUMI_USERS: string
  SYNC_MODE?: 'merge'
}

interface QueueBatch {
  messages: Array<{ body: unknown; ack?: () => void }>
}

const COLLECTION_TYPES = ['want', 'watched', 'watching', 'on_hold', 'dropped'] as const

function usersFromEnv(value: string): string[] {
  return value.split(',').map((part) => part.trim()).filter(Boolean)
}

function imageSources(collection: any): { common?: string; large?: string } {
  return {
    common: collection.subject?.images?.common,
    large: collection.subject?.images?.large,
  }
}

async function runScheduledSync(env: SyncEnv): Promise<void> {
  const storage = new KVStorage(env.AIRING_CAL_KV)
  const client = new BgmClient(env.BANGUMI_TOKEN)
  const users = usersFromEnv(env.BANGUMI_USERS)
  if (!users.length) throw new Error('sync-worker: BANGUMI_USERS is empty')

  const collectionGroups = await Promise.all(users.map((user) => fetchAllCollections(client, user)))
  const collections = collectionGroups.flat()
  const calendar = await client.getCalendar()
  const merged = mergeCollections(collections as any[])

  const summary: Record<string, number> = {}
  for (const type of COLLECTION_TYPES) {
    const list = merged[type]
    await storage.put(snapshotCollectionsKey(type), list)
    summary[type] = list.length
  }
  summary._total = COLLECTION_TYPES.reduce((total, type) => total + summary[type], 0)
  await storage.put(snapshotSummaryKey(), summary)
  await storage.put(snapshotCalendarKey(), calendar)
  await storage.put(syncMetaKey(), {
    synced_at: Math.floor(Date.now() / 1000),
    mode: 'merge',
    users,
  })

  const queued = new Set<number>()
  for (const collection of collections as any[]) {
    if (queued.has(collection.subject_id)) continue
    const images = imageSources(collection)
    if (!images.common && !images.large) continue
    queued.add(collection.subject_id)
    await env.MEDIA_QUEUE.send({
      subject_id: collection.subject_id,
      title: collection.subject?.name_cn || collection.subject?.name || String(collection.subject_id),
      images,
    })
  }
}

async function fetch(_request?: Request, _env?: unknown): Promise<Response> {
  return new Response('Not found', { status: 404 })
}

function shouldRunSync(scheduledTime: number): boolean {
  const hour = new Date(scheduledTime).getUTCHours()
  return hour % 4 === 0
}

async function scheduled(event: { scheduledTime?: number }, env: SyncEnv, ctx: { waitUntil(promise: Promise<unknown>): unknown }): Promise<void> {
  if (!shouldRunSync(event.scheduledTime ?? Date.now())) return
  const promise = runScheduledSync(env)
  ctx.waitUntil(promise)
  await promise
}

async function queue(batch: QueueBatch, env: SyncEnv): Promise<void> {
  for (const message of batch.messages) {
    await runScheduledSync(env)
    message.ack?.()
  }
}

export { runScheduledSync, shouldRunSync }
export default { fetch, scheduled, queue }
