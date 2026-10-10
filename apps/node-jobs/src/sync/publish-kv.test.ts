import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import { buildPublicSnapshot } from '@airing-cal/domain'
import { PUBLIC_READ_MODE_KV_KEY } from '@airing-cal/storage'
import type { CloudflareKvClient } from '../adapters/cloudflare-kv.ts'
import { projectPublicSnapshotInput } from './project-public.ts'
import { publishPublicReadKv } from './publish-kv.ts'

class MemoryKv implements CloudflareKvClient {
  store = new Map<string, unknown>()

  async putJson(key: string, value: unknown): Promise<void> {
    this.store.set(key, value)
  }

  async getJson(key: string): Promise<unknown | null> {
    return this.store.get(key) ?? null
  }
}

test('publishPublicReadKv writes read mode and pointer', async () => {
  const kv = new MemoryKv()
  const input = assembleFullFetch(
    [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
    [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
    1_700_000_000,
  )
  const snapshot = await buildPublicSnapshot(projectPublicSnapshotInput(input), 1)
  await publishPublicReadKv(kv, snapshot, 1_700_000_100)
  assert.equal((kv.store.get(PUBLIC_READ_MODE_KV_KEY) as { mode: string }).mode, 'r2')
  const pointer = kv.store.get('public:current') as { generation: number; content_hash: string }
  assert.equal(pointer.generation, 1)
  assert.equal(pointer.content_hash, snapshot.content_hash)
})
