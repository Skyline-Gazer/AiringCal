import type { DatabaseSync } from 'node:sqlite'
import type { CompleteFullFetch } from '@airing-cal/bgm-api'
import type { SubjectImageMap } from '@airing-cal/domain'
import { createBuilderSqliteD1Client } from '@airing-cal/v3-builder'
import type { SubjectMediaPublishHint } from '@airing-cal/v3-core'
import type { CloudflareD1Client } from '../adapters/cloudflare-d1.ts'
import { createFilesystemBlobStore } from '../adapters/filesystem-blob-store.ts'
import type { RunContext } from '../adapters/run-context.ts'
import type { MediaRefreshPort, MediaRefreshSummary, MediaSubjectSource } from './media-port.ts'
import {
  createSubjectMediaRefresh,
  loadSubjectImageMap,
  loadSubjectMediaPublishHints,
  type SubjectMediaRefreshDeps,
} from './media-refresh.ts'

export interface PortableMediaRefreshResult {
  summary: MediaRefreshSummary
  imageMap: SubjectImageMap
  mediaHints: Map<number, SubjectMediaPublishHint>
}

export interface PortableMediaRefreshOptions {
  db: DatabaseSync
  imageRoot: string
  run: RunContext
  input: CompleteFullFetch
  subjects: MediaSubjectSource[]
  fetchImage?: SubjectMediaRefreshDeps['fetchImage']
  media?: MediaRefreshPort
}

export async function runPortableMediaRefresh(
  options: PortableMediaRefreshOptions,
): Promise<PortableMediaRefreshResult> {
  const d1 = createBuilderSqliteD1Client(options.db) as unknown as CloudflareD1Client
  const store = createFilesystemBlobStore(options.imageRoot)
  const media = options.media ?? createSubjectMediaRefresh({ db: d1, store, fetchImage: options.fetchImage })
  try {
    const summary = await media.refresh(
      { ...options.run, observedAt: new Date(options.input.observedAt * 1000).toISOString() },
      { subjects: options.subjects },
    )
    const imageMap = await loadSubjectImageMap(d1)
    const mediaHints = await loadSubjectMediaPublishHints(d1)
    return { summary, imageMap, mediaHints }
  } finally {
    store.close()
  }
}
