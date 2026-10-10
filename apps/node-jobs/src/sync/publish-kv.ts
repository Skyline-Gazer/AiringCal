import { snapshotObjectKey } from '@airing-cal/domain'
import { PUBLIC_READ_MODE_KV_KEY, type PublicSnapshotV1 } from '@airing-cal/storage'
import type { CloudflareKvClient } from '../adapters/cloudflare-kv.ts'

const POINTER_KEY = 'public:current'

export async function publishPublicReadKv(
  kv: CloudflareKvClient,
  snapshot: PublicSnapshotV1,
  publishedAtSec: number,
): Promise<void> {
  const readMode = await kv.getJson(PUBLIC_READ_MODE_KV_KEY)
  const alreadyR2 = typeof readMode === 'object'
    && readMode !== null
    && !Array.isArray(readMode)
    && (readMode as { mode?: unknown }).mode === 'r2'
  if (!alreadyR2) {
    await kv.putJson(PUBLIC_READ_MODE_KV_KEY, { mode: 'r2', switched_at: publishedAtSec })
  }
  await kv.putJson(POINTER_KEY, {
    schema_version: 1,
    generation: snapshot.generation,
    content_hash: snapshot.content_hash,
    r2_key: snapshotObjectKey(snapshot),
    published_at: publishedAtSec,
  })
}
