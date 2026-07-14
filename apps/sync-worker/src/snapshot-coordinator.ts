import { snapshotActiveKey, type SnapshotManifest } from '@airing-cal/storage'

interface CoordinatorStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
}

interface JsonKV {
  put(key: string, value: string): Promise<void>
}

interface SnapshotCoordinatorEnv {
  AIRING_CAL_KV: JsonKV
}

type CommitResult = { status: 'committed' | 'obsolete'; generation: number }

const NEXT_GENERATION_KEY = 'nextGeneration'
const INSTANCE_PREFIX = 'instance:'
const LAST_COMMITTED_KEY = 'lastCommittedGeneration'
const LAST_MANIFEST_KEY = 'lastCommittedManifest'

export class SnapshotCoordinatorCore {
  constructor(private storage: CoordinatorStorage, private kv: JsonKV) {}

  async allocate(instanceId: string): Promise<number> {
    const instanceKey = `${INSTANCE_PREFIX}${instanceId}`
    const existing = await this.storage.get<number>(instanceKey)
    if (existing !== undefined) return existing
    const generation = (await this.storage.get<number>(NEXT_GENERATION_KEY) ?? 0) + 1
    await this.storage.put(NEXT_GENERATION_KEY, generation)
    await this.storage.put(instanceKey, generation)
    return generation
  }

  async commit(generation: number, manifest: SnapshotManifest): Promise<CommitResult> {
    const lastGeneration = await this.storage.get<number>(LAST_COMMITTED_KEY) ?? 0
    if (generation < lastGeneration) return { status: 'obsolete', generation }
    if (generation === lastGeneration) {
      const lastManifest = await this.storage.get<SnapshotManifest>(LAST_MANIFEST_KEY)
      return {
        status: lastManifest?.instance_id === manifest.instance_id ? 'committed' : 'obsolete',
        generation,
      }
    }
    await this.kv.put(snapshotActiveKey(), JSON.stringify(manifest))
    await this.storage.put(LAST_COMMITTED_KEY, generation)
    await this.storage.put(LAST_MANIFEST_KEY, manifest)
    return { status: 'committed', generation }
  }
}

export class SnapshotCoordinator {
  private core: SnapshotCoordinatorCore
  private tail: Promise<void> = Promise.resolve()

  constructor(state: DurableObjectState, env: SnapshotCoordinatorEnv) {
    this.core = new SnapshotCoordinatorCore(state.storage, env.AIRING_CAL_KV)
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const body = await request.json<Record<string, unknown>>()
    return this.serialized(async () => {
      if (url.pathname === '/allocate' && typeof body.instance_id === 'string') {
        return Response.json({ generation: await this.core.allocate(body.instance_id) })
      }
      if (url.pathname === '/commit' && typeof body.generation === 'number' && body.manifest) {
        return Response.json(await this.core.commit(body.generation, body.manifest as SnapshotManifest))
      }
      return Response.json({ error: 'Invalid coordinator request' }, { status: 400 })
    })
  }
}
