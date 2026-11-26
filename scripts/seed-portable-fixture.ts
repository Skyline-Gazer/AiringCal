/**
 * Publishes a synthetic public release into a filesystem public store.
 *
 * Used by `scripts/v3-portable-e2e.mjs` (portable read-gateway smoke) and handy
 * for local Compose runs that need a published release without bgm.tv access.
 * Synthetic data only — never contains real user data.
 *
 * Usage: pnpm exec tsx scripts/seed-portable-fixture.ts <publicDir>
 */
import { assembleFullFetch, type BgmCollection } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { FilesystemPublicStore } from '@airing-cal/v3-core'

const IMAGE = 'https://lain.bgm.tv/pic/cover/l/'
  + 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg'

function entry(id: number, type: number): BgmCollection {
  return {
    subject_id: id,
    subject_type: 2,
    rate: 7,
    type,
    comment: '',
    tags: ['a'],
    ep_status: 2,
    vol_status: 0,
    updated_at: '2026-10-17T00:00:00.000Z',
    private: false,
    subject: {
      id,
      type: 2,
      name: `Subject ${id}`,
      name_cn: `中文${id}`,
      summary: 'summary',
      nsfw: false,
      date: '2026-10-17',
      eps: 12,
      total_episodes: 12,
      images: { large: IMAGE, common: IMAGE, medium: IMAGE, small: IMAGE, grid: IMAGE },
      rating: { score: 7, rank: 10, total: 100 },
    },
  }
}

const fetch = assembleFullFetch(
  [{
    user_id: '1',
    pageLimit: 50,
    pages: [{ offset: 0, total: 3, data: [entry(11, 3), entry(21, 2), entry(31, 5)] }],
  }],
  [{
    weekday: { en: 'Sat', cn: '六', ja: '土', id: 6 },
    items: [{
      id: 11,
      type: 2,
      name: 'Subject 11',
      name_cn: '中文11',
      summary: '',
      nsfw: false,
      date: '2026-10-17',
      eps: 12,
      total_episodes: 12,
      images: { large: IMAGE, common: IMAGE, medium: IMAGE, small: IMAGE, grid: IMAGE },
      rating: { score: 0, rank: 0, total: 0 },
    }],
  }],
  1_750_000_000,
)

const publicDir = process.argv[2]
if (!publicDir) {
  console.error(JSON.stringify({ status: 'failed', stage: 'seed_portable_fixture', message: 'publicDir is required' }))
  process.exit(1)
}

async function main(): Promise<void> {
  const store = new FilesystemPublicStore(publicDir)
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    await runBuilderSyncJob({
      state,
      runs,
      runId: 'seed',
      mode: 'incremental',
      ownerToken: 'seed',
      fetchInput: async () => fetch,
      now: () => 1_750_000_000_000,
      projectFetchMediaHints: true,
    })
    const published = await publishBuilderCheckpoint({
      state,
      publicStore: store,
      manifestMetadata: { source_observed_at: '2026-10-17T00:00:00.000Z', git_sha: 'b'.repeat(40) },
    })
    if (published.status !== 'published') {
      console.error(JSON.stringify({ status: 'failed', stage: 'seed_portable_fixture', message: published.status }))
      process.exit(1)
    }
    console.log(JSON.stringify({ status: 'ok', stage: 'seed_portable_fixture', publicDir, generation: published.pointer?.generation }))
  } finally {
    db.close()
  }
}

void main()
