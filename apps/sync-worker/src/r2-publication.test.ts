import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPublicSnapshot,
  parsePublicSnapshotV1,
  type PublicSnapshotInput,
} from '@airing-cal/domain'
import type {
  PublicCollectionItemV1,
  PublicSnapshotPointerV1,
} from '@airing-cal/storage'
import { canonicalJson } from '@airing-cal/storage'
import {
  publishPublicSnapshot,
  type PublicationDataBucket,
  type PublicationPointerKv,
  type PublicationState,
} from './r2-publication.ts'

const NOW = 1_753_632_000

test('publication ports accept the generated Cloudflare R2 and KV binding types', () => {
  if (false) {
    const generatedBucket = null as unknown as R2Bucket
    const generatedKv = null as unknown as KVNamespace
    const dataBucket: PublicationDataBucket = generatedBucket
    const pointerKv: PublicationPointerKv = generatedKv
    assert.ok(dataBucket)
    assert.ok(pointerKv)
  }
  assert.ok(true)
})

function emptyInput(publishedAt = NOW): PublicSnapshotInput {
  return {
    collections: [],
    calendar: [],
    published_at: publishedAt,
  }
}

function collection(subjectId: number): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: `Subject ${subjectId}`,
    name_cn: `条目 ${subjectId}`,
    summary: '',
    images: { common: null, large: null },
    eps: 12,
    total_episodes: 12,
    ep_status: 1,
    vol_status: 0,
    type: 2,
    collection_type: 3,
    rate: 8,
    nsfw: false,
    date: '2026-07-01',
    tags: [],
    updated_at: '2026-07-27T00:00:00Z',
  }
}

async function publicationInput(
  input: PublicSnapshotInput,
): Promise<PublicSnapshotInput & { content_hash: string }> {
  const snapshot = await buildPublicSnapshot(input, 0)
  return { ...input, content_hash: snapshot.content_hash }
}

async function pointerFor(
  input: PublicSnapshotInput,
  generation: number,
): Promise<PublicSnapshotPointerV1> {
  const snapshot = await buildPublicSnapshot(input, generation)
  return {
    schema_version: 1,
    generation,
    content_hash: snapshot.content_hash,
    r2_key: `snapshots/v1/${generation}-${snapshot.content_hash}.json`,
    published_at: input.published_at,
  }
}

class MemoryState implements PublicationState {
  readonly events: string[]
  verified?: PublicSnapshotPointerV1
  pending?: PublicSnapshotPointerV1
  allocations = 0

  constructor(
    events: string[],
    initial: {
      verified?: PublicSnapshotPointerV1
      pending?: PublicSnapshotPointerV1
    } = {},
  ) {
    this.events = events
    this.verified = initial.verified
    this.pending = initial.pending
  }

  async getVerifiedPublication() {
    return this.verified
  }

  async getPendingPublication() {
    return this.pending
  }

  async commitPendingPublication(candidate: PublicSnapshotPointerV1) {
    this.events.push('d1:commit-state')
    this.allocations++
    this.pending = structuredClone(candidate)
    return true
  }

  async markPublicationPublished(candidate: PublicSnapshotPointerV1) {
    this.events.push('d1:mark-published')
    this.verified = structuredClone(candidate)
    this.pending = undefined
  }
}

class MemoryBucket implements PublicationDataBucket {
  readonly objects = new Map<string, string>()

  constructor(protected readonly events: string[]) {}

  async put(key: string, value: string, options?: { onlyIf?: Headers }) {
    this.events.push('r2:put')
    assert.equal(options?.onlyIf?.get('If-None-Match'), '*')
    if (this.objects.has(key)) return null
    this.objects.set(key, value)
    return { key }
  }

  async get(key: string) {
    this.events.push('r2:get')
    const value = this.objects.get(key)
    return value === undefined ? null : { key, async text() { return value } }
  }
}

class MemoryKv implements PublicationPointerKv {
  readonly values = new Map<string, string>()

  constructor(protected readonly events: string[]) {}

  async get(key: string) {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string) {
    this.events.push(`kv:put:${key}`)
    this.values.set(key, value)
  }
}

class FaultBucket extends MemoryBucket {
  failPut = false
  failGet = false
  mutateBody?: (value: Record<string, unknown>) => void
  returnedKey?: string

  override async put(key: string, value: string, options?: { onlyIf?: Headers }) {
    if (!this.failPut) return await super.put(key, value, options)
    this.events.push('r2:put')
    throw new Error('injected R2 PUT failure')
  }

  override async get(key: string) {
    if (this.failGet) {
      this.events.push('r2:get')
      throw new Error('injected R2 GET failure')
    }
    const stored = await super.get(key)
    if (stored === null) return null
    const value = JSON.parse(await stored.text()) as Record<string, unknown>
    this.mutateBody?.(value)
    const bytes = canonicalJson(value)
    return {
      key: this.returnedKey ?? stored.key,
      async text() {
        return bytes
      },
    }
  }
}

class FaultKv extends MemoryKv {
  mode: 'normal' | 'throw-before' | 'store-then-throw' | 'mismatch-then-throw' | 'missing-then-throw' = 'normal'
  failReadback = false

  override async get(key: string) {
    if (this.failReadback) throw new Error('injected KV readback failure')
    return await super.get(key)
  }

  override async put(key: string, value: string) {
    if (this.mode === 'normal') return await super.put(key, value)
    this.events.push(`kv:put:${key}`)
    if (this.mode === 'store-then-throw') this.values.set(key, value)
    if (this.mode === 'mismatch-then-throw') this.values.set(key, '{"competing":true}')
    if (this.mode === 'missing-then-throw') this.values.delete(key)
    throw new Error('injected ambiguous KV PUT failure')
  }
}

class FaultState extends MemoryState {
  failCommit = false
  commitThenThrow = false
  failMark = false
  markThenThrow = false

  override async commitPendingPublication(candidate: PublicSnapshotPointerV1) {
    if (this.failCommit) {
      this.events.push('d1:commit-state')
      throw new Error('injected D1 pending commit failure')
    }
    const committed = await super.commitPendingPublication(candidate)
    if (this.commitThenThrow) throw new Error('injected D1 commit response loss')
    return committed
  }

  override async markPublicationPublished(candidate: PublicSnapshotPointerV1) {
    if (this.failMark) {
      this.events.push('d1:mark-published')
      throw new Error('injected D1 published-state failure')
    }
    await super.markPublicationPublished(candidate)
    if (this.markThenThrow) throw new Error('injected D1 mark response loss')
  }
}

async function changedFixture() {
  const events: string[] = []
  const oldPointer = await pointerFor(emptyInput(), 11)
  const input = await publicationInput({
    ...emptyInput(),
    collections: [collection(2)],
  })
  const state = new FaultState(events, { verified: oldPointer })
  const dataBucket = new FaultBucket(events)
  const pointerKv = new FaultKv(events)
  const oldPointerBytes = ` {\n  "legacy": ${JSON.stringify(oldPointer)}\n}`
  pointerKv.values.set('public:current', oldPointerBytes)
  return { events, oldPointer, input, state, dataBucket, pointerKv, oldPointerBytes }
}

test('identical verified content is unchanged before generation allocation or R2/KV writes', async () => {
  const input = emptyInput()
  const verified = await pointerFor(input, 4)
  let allocations = 0
  const state: PublicationState = {
    async getVerifiedPublication() {
      return verified
    },
    async getPendingPublication() {
      return undefined
    },
    async commitPendingPublication() {
      allocations++
      throw new Error('unchanged publication allocated a generation')
    },
    async markPublicationPublished() {
      throw new Error('unchanged publication changed D1 publication state')
    },
  }

  const result = await publishPublicSnapshot({
    state,
    dataBucket: {
      async put() {
        throw new Error('unchanged publication wrote R2')
      },
      async get() {
        throw new Error('unchanged publication read R2')
      },
    },
    pointerKv: {
      async get() {
        throw new Error('unchanged publication read KV')
      },
      async put() {
        throw new Error('unchanged publication wrote KV')
      },
    },
    input: { ...input, content_hash: verified.content_hash },
    now: NOW,
  })

  assert.deepEqual(result, {
    status: 'unchanged',
    generation: 4,
    contentHash: verified.content_hash,
    r2Puts: 0,
    pointerPuts: 0,
  })
  assert.equal(allocations, 0)
})

test('changed content commits pending state, writes and verifies R2, switches one pointer, then marks D1 published', async () => {
  const events: string[] = []
  const oldInput = emptyInput()
  const oldPointer = await pointerFor(oldInput, 7)
  const input = await publicationInput({
    ...emptyInput(),
    collections: [collection(1)],
  })
  const state = new MemoryState(events, { verified: oldPointer })
  const dataBucket = new MemoryBucket(events)
  const pointerKv = new MemoryKv(events)
  const oldPointerBytes = JSON.stringify(oldPointer)
  pointerKv.values.set('public:current', oldPointerBytes)

  const result = await publishPublicSnapshot({
    state,
    dataBucket,
    pointerKv,
    input,
    now: NOW,
  })

  assert.deepEqual(events, [
    'd1:commit-state',
    'r2:put',
    'r2:get',
    'kv:put:public:current',
    'd1:mark-published',
  ])
  assert.deepEqual(result, {
    status: 'published',
    generation: 8,
    contentHash: input.content_hash,
    r2Puts: 1,
    pointerPuts: 1,
  })
  assert.equal(state.allocations, 1)
  assert.equal(state.pending, undefined)
  assert.equal(state.verified?.r2_key, `snapshots/v1/8-${input.content_hash}.json`)
  const objectBytes = dataBucket.objects.get(state.verified!.r2_key)
  assert.ok(objectBytes)
  const parsed = await parsePublicSnapshotV1(JSON.parse(objectBytes))
  assert.equal(parsed.generation, 8)
  assert.equal(parsed.content_hash, input.content_hash)
  assert.equal(parsed.published_at, NOW)
  assert.equal(pointerKv.values.get('public:current'), canonicalJson({
    schema_version: 1,
    generation: 8,
    content_hash: input.content_hash,
    published_at: NOW,
    r2_key: `snapshots/v1/8-${input.content_hash}.json`,
  }))
})

test('D1 pending commit failure performs no R2/KV work and preserves the old pointer bytes', async () => {
  const fixture = await changedFixture()
  fixture.state.failCommit = true

  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  }), /D1 pending commit failure/)

  assert.deepEqual(fixture.events, ['d1:commit-state'])
  assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
})

test('R2 PUT and GET failures preserve the byte-identical old pointer', async (t) => {
  for (const stage of ['put', 'get'] as const) {
    await t.test(stage, async () => {
      const fixture = await changedFixture()
      fixture.dataBucket.failPut = stage === 'put'
      fixture.dataBucket.failGet = stage === 'get'

      await assert.rejects(() => publishPublicSnapshot({
        state: fixture.state,
        dataBucket: fixture.dataBucket,
        pointerKv: fixture.pointerKv,
        input: fixture.input,
        now: NOW,
      }), new RegExp(`R2 ${stage.toUpperCase()} failure`))

      assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
      assert.equal(fixture.events.some((event) => event.startsWith('kv:put:')), false)
    })
  }
})

test('R2 readback rejects schema, generation, content hash, and object-key corruption before pointer PUT', async (t) => {
  const cases: Array<{
    name: string
    pattern: RegExp
    configure(bucket: FaultBucket): void
  }> = [
    {
      name: 'schema',
      pattern: /Unsupported public snapshot schema_version/,
      configure: (bucket) => {
        bucket.mutateBody = (value) => { value.schema_version = 2 }
      },
    },
    {
      name: 'generation',
      pattern: /generation mismatch/,
      configure: (bucket) => {
        bucket.mutateBody = (value) => { value.generation = Number(value.generation) + 1 }
      },
    },
    {
      name: 'content hash',
      pattern: /content_hash/,
      configure: (bucket) => {
        bucket.mutateBody = (value) => { value.content_hash = '0'.repeat(64) }
      },
    },
    {
      name: 'object key',
      pattern: /object key mismatch/,
      configure: (bucket) => {
        bucket.returnedKey = 'snapshots/v1/wrong.json'
      },
    },
  ]

  for (const corruption of cases) {
    await t.test(corruption.name, async () => {
      const fixture = await changedFixture()
      corruption.configure(fixture.dataBucket)

      await assert.rejects(() => publishPublicSnapshot({
        state: fixture.state,
        dataBucket: fixture.dataBucket,
        pointerKv: fixture.pointerKv,
        input: fixture.input,
        now: NOW,
      }), corruption.pattern)

      assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
      assert.equal(fixture.events.some((event) => event.startsWith('kv:put:')), false)
    })
  }
})

test('invalid canonical publication input hash fails before generation allocation and preserves the pointer', async () => {
  const fixture = await changedFixture()
  fixture.input.content_hash = 'f'.repeat(64)

  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  }), /publication input content_hash/)

  assert.equal(fixture.state.allocations, 0)
  assert.deepEqual(fixture.events, [])
  assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
})

test('definite KV failure returns pending and keeps the old pointer byte-identical', async () => {
  const fixture = await changedFixture()
  fixture.pointerKv.mode = 'throw-before'

  const result = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.pointerPuts, 0)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.state.verified, fixture.oldPointer)
  assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
})

test('ambiguous KV outcome is published only when readback is the exact candidate', async () => {
  const fixture = await changedFixture()
  fixture.pointerKv.mode = 'store-then-throw'

  const result = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })

  assert.equal(result.status, 'published')
  assert.equal(result.pointerPuts, 1)
  assert.equal(fixture.state.pending, undefined)
  assert.equal(fixture.state.verified?.generation, 12)
})

test('ambiguous KV mismatch or missing readback stays pending without marking D1 published', async (t) => {
  for (const mode of ['mismatch-then-throw', 'missing-then-throw'] as const) {
    await t.test(mode, async () => {
      const fixture = await changedFixture()
      fixture.pointerKv.mode = mode

      const result = await publishPublicSnapshot({
        state: fixture.state,
        dataBucket: fixture.dataBucket,
        pointerKv: fixture.pointerKv,
        input: fixture.input,
        now: NOW,
      })

      assert.equal(result.status, 'pending')
      assert.equal(result.pointerPuts, 0)
      assert.equal(fixture.state.pending?.generation, 12)
      assert.equal(fixture.events.includes('d1:mark-published'), false)
    })
  }
})

test('ambiguous KV readback failure stays pending for replay', async () => {
  const fixture = await changedFixture()
  fixture.pointerKv.mode = 'store-then-throw'
  fixture.pointerKv.failReadback = true

  const result = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.pointerPuts, 0)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.events.includes('d1:mark-published'), false)
})

test('replay reuses the same pending generation, key, and object without another allocation', async () => {
  const fixture = await changedFixture()
  fixture.pointerKv.mode = 'throw-before'

  const first = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })
  const pending = structuredClone(fixture.state.pending!)
  fixture.pointerKv.mode = 'normal'
  const second = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW + 600,
  })

  assert.equal(first.status, 'pending')
  assert.deepEqual(second, {
    status: 'published',
    generation: pending.generation,
    contentHash: pending.content_hash,
    r2Puts: 0,
    pointerPuts: 1,
  })
  assert.equal(fixture.state.allocations, 1)
  assert.equal(fixture.state.verified?.r2_key, pending.r2_key)
  assert.equal(fixture.state.verified?.published_at, pending.published_at)
  assert.equal(fixture.dataBucket.objects.size, 1)
})

test('D1 published-state response loss is resolved by exact verified readback', async () => {
  const fixture = await changedFixture()
  fixture.state.markThenThrow = true

  const result = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })

  assert.equal(result.status, 'published')
  assert.equal(fixture.state.pending, undefined)
  assert.equal(fixture.state.verified?.generation, 12)
})

test('D1 published-state definite failure leaves the durable candidate pending after pointer switch', async () => {
  const fixture = await changedFixture()
  fixture.state.failMark = true

  const result = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.pointerPuts, 1)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.state.verified, fixture.oldPointer)
})
