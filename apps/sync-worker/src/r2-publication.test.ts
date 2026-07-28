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
  PublicationWriteOwner,
} from '@airing-cal/storage'
import { canonicalJson } from '@airing-cal/storage'
import {
  publishPublicSnapshot,
  type PublicationDataBucket,
  type PublicationPointerKv,
  type PublicationState,
} from './r2-publication.ts'

const NOW = 1_753_632_000

function publicationOwner(
  publicationId: string,
  attemptToken: string,
): PublicationWriteOwner {
  return {
    publication_id: publicationId,
    attempt_token: attemptToken,
  }
}

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
  publicationClaim?: {
    candidate: PublicSnapshotPointerV1
    owner: PublicationWriteOwner
    expiresAt: number
  }
  leaseNow = NOW
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
    if (this.pending !== undefined) {
      if (canonicalJson(this.pending) === canonicalJson(candidate)) return true
      if (
        this.publicationClaim !== undefined
        && this.publicationClaim.expiresAt > this.leaseNow
      ) return false
      this.publicationClaim = undefined
      this.pending = structuredClone(candidate)
      return true
    }
    if (
      !(
        (this.verified === undefined && candidate.generation === 1)
        || this.verified?.generation === candidate.generation - 1
      )
    ) return false
    this.pending = structuredClone(candidate)
    return true
  }

  async cleanupStalePendingPublication(verified: PublicSnapshotPointerV1) {
    if (
      this.verified === undefined
      || canonicalJson(this.verified) !== canonicalJson(verified)
    ) return 'conflict' as const
    if (this.pending === undefined) {
      return this.publicationClaim === undefined ? 'clean' as const : 'conflict' as const
    }
    if (
      this.publicationClaim !== undefined
      && this.publicationClaim.expiresAt > this.leaseNow
    ) {
      return canonicalJson(this.publicationClaim.candidate) === canonicalJson(this.pending)
        ? 'active' as const
        : 'conflict' as const
    }
    this.publicationClaim = undefined
    this.pending = undefined
    return 'cleaned' as const
  }

  async confirmPublicationAuthorized(candidate: PublicSnapshotPointerV1) {
    if (
      this.verified?.generation === candidate.generation
      && this.verified.content_hash === candidate.content_hash
      && this.verified.r2_key === candidate.r2_key
      && this.verified.published_at === candidate.published_at
    ) return 'already_verified' as const
    if (
      this.pending?.generation === candidate.generation
      && this.pending.content_hash === candidate.content_hash
      && this.pending.r2_key === candidate.r2_key
      && this.pending.published_at === candidate.published_at
      && (
        (this.verified === undefined && candidate.generation === 1)
        || this.verified?.generation === candidate.generation - 1
      )
    ) return 'authorized' as const
    return 'conflict' as const
  }

  async claimPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    const authorization = await this.confirmPublicationAuthorized(candidate)
    if (authorization !== 'authorized') return authorization
    if (
      this.publicationClaim !== undefined
      && this.publicationClaim.expiresAt > this.leaseNow
    ) {
      return (
        canonicalJson(this.publicationClaim.candidate) === canonicalJson(candidate)
        && this.publicationClaim.owner.publication_id === owner.publication_id
        && this.publicationClaim.owner.attempt_token === owner.attempt_token
      ) ? 'claimed' as const : 'busy' as const
    }
    if (
      this.publicationClaim !== undefined
      && canonicalJson(this.publicationClaim.candidate) !== canonicalJson(candidate)
    ) return 'busy' as const
    this.publicationClaim = {
      candidate: structuredClone(candidate),
      owner: structuredClone(owner),
      expiresAt: this.leaseNow + 60,
    }
    return 'claimed' as const
  }

  async confirmPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    if (
      this.verified
      && canonicalJson(this.verified) === canonicalJson(candidate)
    ) return 'already_verified' as const
    if (
      this.publicationClaim
      && canonicalJson(this.publicationClaim.candidate) === canonicalJson(candidate)
      && this.publicationClaim.owner.publication_id === owner.publication_id
      && this.publicationClaim.owner.attempt_token === owner.attempt_token
    ) {
      return this.publicationClaim.expiresAt > this.leaseNow
        ? 'active' as const
        : 'expired' as const
    }
    return 'conflict' as const
  }

  async releasePublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    if (
      this.publicationClaim?.owner.publication_id === owner.publication_id
      && this.publicationClaim.owner.attempt_token === owner.attempt_token
      && canonicalJson(this.publicationClaim.candidate) === canonicalJson(candidate)
    ) this.publicationClaim = undefined
  }

  async markPublicationPublished(
    candidate: PublicSnapshotPointerV1,
    owner?: PublicationWriteOwner,
  ) {
    this.events.push('d1:mark-published')
    const authorization = await this.confirmPublicationAuthorized(candidate)
    if (authorization === 'conflict') throw new Error('Publication verified-state conflict')
    if (
      owner !== undefined
      && (
        this.publicationClaim?.owner.publication_id !== owner.publication_id
        || this.publicationClaim.owner.attempt_token !== owner.attempt_token
        || canonicalJson(this.publicationClaim.candidate) !== canonicalJson(candidate)
        || this.publicationClaim.expiresAt <= this.leaseNow
      )
    ) throw new Error('Publication write claim conflict')
    this.verified = structuredClone(candidate)
    this.pending = undefined
    this.publicationClaim = undefined
  }

  advanceLeaseClock(seconds: number) {
    this.leaseNow += seconds
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
  readonly putValues: string[] = []

  constructor(protected readonly events: string[]) {}

  async get(key: string) {
    return this.values.get(key) ?? null
  }

  async put(key: string, value: string) {
    this.events.push(`kv:put:${key}`)
    this.putValues.push(value)
    this.values.set(key, value)
  }
}

class FaultBucket extends MemoryBucket {
  failPut = false
  failGet = false
  mutateBody?: (value: Record<string, unknown>) => void
  returnedKey?: string
  afterGet?: () => void

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
    this.afterGet?.()
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
  beforePut?: () => void | Promise<void>

  override async get(key: string) {
    if (this.failReadback) throw new Error('injected KV readback failure')
    return await super.get(key)
  }

  override async put(key: string, value: string) {
    const beforePut = this.beforePut
    this.beforePut = undefined
    await beforePut?.()
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
  claimThenThrow = false
  failRelease = false
  beforeConfirm?: () => Promise<void>
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

  override async claimPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    const claimed = await super.claimPublicationWrite(candidate, owner)
    if (this.claimThenThrow) {
      this.claimThenThrow = false
      throw new Error('injected D1 claim response loss')
    }
    return claimed
  }

  override async releasePublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    if (this.failRelease) throw new Error('injected D1 claim release failure')
    await super.releasePublicationWrite(candidate, owner)
  }

  override async confirmPublicationWrite(
    candidate: PublicSnapshotPointerV1,
    owner: PublicationWriteOwner,
  ) {
    const beforeConfirm = this.beforeConfirm
    this.beforeConfirm = undefined
    await beforeConfirm?.()
    return await super.confirmPublicationWrite(candidate, owner)
  }

  override async markPublicationPublished(
    candidate: PublicSnapshotPointerV1,
    owner?: PublicationWriteOwner,
  ) {
    if (this.failMark) {
      this.events.push('d1:mark-published')
      throw new Error('injected D1 published-state failure')
    }
    await super.markPublicationPublished(candidate, owner)
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
    async cleanupStalePendingPublication() {
      return 'clean' as const
    },
    async confirmPublicationAuthorized() {
      throw new Error('unchanged publication requested authorization')
    },
    async claimPublicationWrite() {
      throw new Error('unchanged publication claimed pointer write')
    },
    async confirmPublicationWrite() {
      throw new Error('unchanged publication confirmed pointer write')
    },
    async releasePublicationWrite() {
      throw new Error('unchanged publication released pointer write')
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
    publicationId: 'workflow-unchanged',
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
    publicationId: 'workflow-changed',
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
    publicationId: 'workflow-commit-failure',
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
        publicationId: `workflow-r2-${stage}`,
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
        publicationId: `workflow-corrupt-${corruption.name}`,
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
    publicationId: 'workflow-invalid-hash',
  }), /publication input content_hash/)

  assert.equal(fixture.state.allocations, 0)
  assert.deepEqual(fixture.events, [])
  assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
})

test('a lower pending generation than public:verified is rejected before any R2 or KV write', async () => {
  const events: string[] = []
  const verified = await pointerFor(emptyInput(), 5)
  const input = await publicationInput({
    ...emptyInput(),
    collections: [collection(30)],
  })
  const pending: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 4,
    content_hash: input.content_hash,
    r2_key: `snapshots/v1/4-${input.content_hash}.json`,
    published_at: NOW,
  }
  const state = new MemoryState(events, { verified, pending })
  const dataBucket = new MemoryBucket(events)
  const pointerKv = new MemoryKv(events)

  await assert.rejects(() => publishPublicSnapshot({
    state,
    dataBucket,
    pointerKv,
    input,
    now: NOW,
    publicationId: 'workflow-lower-pending',
  }), /publication authorization conflict/i)

  assert.deepEqual(events, [])
  assert.equal(dataBucket.objects.size, 0)
  assert.equal(pointerKv.values.has('public:current'), false)
})

test('a same-generation pending hash conflict is rejected before any R2 or KV write', async () => {
  const events: string[] = []
  const verified = await pointerFor(emptyInput(), 5)
  const input = await publicationInput({
    ...emptyInput(),
    collections: [collection(31)],
  })
  const pending: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 5,
    content_hash: input.content_hash,
    r2_key: `snapshots/v1/5-${input.content_hash}.json`,
    published_at: NOW,
  }
  const state = new MemoryState(events, { verified, pending })
  const dataBucket = new MemoryBucket(events)
  const pointerKv = new MemoryKv(events)

  await assert.rejects(() => publishPublicSnapshot({
    state,
    dataBucket,
    pointerKv,
    input,
    now: NOW,
    publicationId: 'workflow-same-generation',
  }), /publication authorization conflict/i)

  assert.deepEqual(events, [])
  assert.equal(dataBucket.objects.size, 0)
  assert.equal(pointerKv.values.has('public:current'), false)
})

test('verified advancement after pending commit but before KV prevents a stale pointer PUT', async () => {
  const fixture = await changedFixture()
  const newerInput = await publicationInput({
    ...emptyInput(),
    collections: [collection(99)],
  })
  fixture.dataBucket.afterGet = () => {
    fixture.state.verified = {
      schema_version: 1,
      generation: 13,
      content_hash: newerInput.content_hash,
      r2_key: `snapshots/v1/13-${newerInput.content_hash}.json`,
      published_at: NOW + 1,
    }
  }

  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-verified-advance',
  }), /publication authorization conflict/i)

  assert.equal(fixture.events.includes('kv:put:public:current'), false)
  assert.equal(fixture.pointerKv.values.get('public:current'), fixture.oldPointerBytes)
})

test('a failed unclaimed pending publication is superseded by later authoritative content at the same next generation', async () => {
  const fixture = await changedFixture()
  fixture.dataBucket.failPut = true
  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-b',
  }), /R2 PUT failure/)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.state.publicationClaim, undefined)

  const inputC = await publicationInput({
    ...emptyInput(),
    collections: [collection(102)],
  })
  fixture.dataBucket.failPut = false
  const published = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: inputC,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })

  assert.equal(published.status, 'published')
  assert.equal(published.generation, 12)
  assert.equal(fixture.state.verified?.content_hash, inputC.content_hash)
})

test('an active pending owner blocks distinct later content before R2 or KV', async () => {
  const fixture = await changedFixture()
  await fixture.state.commitPendingPublication({
    schema_version: 1,
    generation: 12,
    content_hash: fixture.input.content_hash,
    r2_key: `snapshots/v1/12-${fixture.input.content_hash}.json`,
    published_at: NOW,
  })
  const owner = publicationOwner('workflow-b', 'attempt-b')
  assert.equal(
    await fixture.state.claimPublicationWrite(fixture.state.pending!, owner),
    'claimed',
  )
  const inputC = await publicationInput({
    ...emptyInput(),
    collections: [collection(103)],
  })

  const blocked = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: inputC,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })

  assert.equal(blocked.status, 'pending')
  assert.equal(blocked.generation, 12)
  assert.equal(fixture.dataBucket.objects.size, 0)
  assert.equal(fixture.pointerKv.putValues.length, 0)
})

test('an expired pending owner is fenced while later content supersedes and publishes', async () => {
  const fixture = await changedFixture()
  await fixture.state.commitPendingPublication({
    schema_version: 1,
    generation: 12,
    content_hash: fixture.input.content_hash,
    r2_key: `snapshots/v1/12-${fixture.input.content_hash}.json`,
    published_at: NOW,
  })
  const owner = publicationOwner('workflow-b', 'attempt-b')
  assert.equal(
    await fixture.state.claimPublicationWrite(fixture.state.pending!, owner),
    'claimed',
  )
  fixture.state.advanceLeaseClock(61)
  const inputC = await publicationInput({
    ...emptyInput(),
    collections: [collection(104)],
  })

  const published = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: inputC,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })

  assert.equal(published.status, 'published')
  assert.equal(published.generation, 12)
  assert.equal(await fixture.state.confirmPublicationWrite(
    {
      schema_version: 1,
      generation: 12,
      content_hash: fixture.input.content_hash,
      r2_key: `snapshots/v1/12-${fixture.input.content_hash}.json`,
      published_at: NOW,
    },
    owner,
  ), 'conflict')
  await assert.rejects(
    fixture.state.markPublicationPublished({
      schema_version: 1,
      generation: 12,
      content_hash: fixture.input.content_hash,
      r2_key: `snapshots/v1/12-${fixture.input.content_hash}.json`,
      published_at: NOW,
    }, owner),
    /claim conflict|verified-state conflict/,
  )
  await fixture.state.releasePublicationWrite(fixture.state.verified!, owner)
  assert.equal(fixture.state.verified?.content_hash, inputC.content_hash)
})

test('verified no-op cleans an unclaimed stale pending publication without R2 or KV writes', async () => {
  const events: string[] = []
  const verified = await pointerFor(emptyInput(), 5)
  const staleInput = await publicationInput({
    ...emptyInput(),
    collections: [collection(105)],
  })
  const pending: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 6,
    content_hash: staleInput.content_hash,
    r2_key: `snapshots/v1/6-${staleInput.content_hash}.json`,
    published_at: NOW,
  }
  const state = new MemoryState(events, { verified, pending })
  const result = await publishPublicSnapshot({
    state,
    dataBucket: new MemoryBucket(events),
    pointerKv: new MemoryKv(events),
    input: { ...emptyInput(), content_hash: verified.content_hash },
    now: NOW,
    publicationId: 'workflow-a',
  })

  assert.equal(result.status, 'unchanged')
  assert.equal(state.pending, undefined)
  assert.equal(events.some((event) => event.startsWith('r2:')), false)
  assert.equal(events.some((event) => event.startsWith('kv:')), false)
})

test('verified input stays pending behind an active stale writer then restores itself after that writer publishes', async () => {
  const events: string[] = []
  const inputA = emptyInput()
  const verifiedA = await pointerFor(inputA, 5)
  const inputB = await publicationInput({
    ...emptyInput(),
    collections: [collection(106)],
  })
  const pendingB: PublicSnapshotPointerV1 = {
    schema_version: 1,
    generation: 6,
    content_hash: inputB.content_hash,
    r2_key: `snapshots/v1/6-${inputB.content_hash}.json`,
    published_at: NOW,
  }
  const ownerB = publicationOwner('workflow-b', 'attempt-b')
  const state = new MemoryState(events, { verified: verifiedA, pending: pendingB })
  const dataBucket = new MemoryBucket(events)
  const pointerKv = new MemoryKv(events)
  assert.equal(await state.claimPublicationWrite(pendingB, ownerB), 'claimed')

  const blockedA = await publishPublicSnapshot({
    state,
    dataBucket,
    pointerKv,
    input: { ...inputA, content_hash: verifiedA.content_hash },
    now: NOW,
    publicationId: 'workflow-a',
  })

  assert.equal(blockedA.status, 'pending')
  assert.equal(blockedA.generation, 6)
  assert.equal(dataBucket.objects.size, 0)
  assert.equal(pointerKv.putValues.length, 0)

  await state.markPublicationPublished(pendingB, ownerB)
  const restoredA = await publishPublicSnapshot({
    state,
    dataBucket,
    pointerKv,
    input: { ...inputA, content_hash: verifiedA.content_hash },
    now: NOW + 1,
    publicationId: 'workflow-a-retry',
  })

  assert.equal(restoredA.status, 'published')
  assert.equal(restoredA.generation, 7)
  assert.equal(state.verified?.content_hash, verifiedA.content_hash)
  assert.deepEqual(
    pointerKv.putValues.map((value) => JSON.parse(value).generation),
    [7],
  )
})

test('verified advancement during stale cleanup is re-read before deciding unchanged', async () => {
  const events: string[] = []
  const inputA = emptyInput()
  const verifiedA = await pointerFor(inputA, 5)
  const inputB = await publicationInput({
    ...emptyInput(),
    collections: [collection(108)],
  })
  const verifiedB = await pointerFor(inputB, 6)
  class AdvancingCleanupState extends MemoryState {
    override async cleanupStalePendingPublication() {
      this.verified = structuredClone(verifiedB)
      this.pending = undefined
      return 'conflict' as const
    }
  }
  const state = new AdvancingCleanupState(events, { verified: verifiedA })
  const pointerKv = new MemoryKv(events)

  const result = await publishPublicSnapshot({
    state,
    dataBucket: new MemoryBucket(events),
    pointerKv,
    input: { ...inputA, content_hash: verifiedA.content_hash },
    now: NOW + 1,
    publicationId: 'workflow-a',
  })

  assert.equal(result.status, 'published')
  assert.equal(result.generation, 7)
  assert.equal(state.verified?.content_hash, verifiedA.content_hash)
  assert.deepEqual(
    pointerKv.putValues.map((value) => JSON.parse(value).generation),
    [7],
  )
})

test('pending supersession response loss replays the exact replacement candidate', async () => {
  const fixture = await changedFixture()
  await fixture.state.commitPendingPublication({
    schema_version: 1,
    generation: 12,
    content_hash: fixture.input.content_hash,
    r2_key: `snapshots/v1/12-${fixture.input.content_hash}.json`,
    published_at: NOW,
  })
  const inputC = await publicationInput({
    ...emptyInput(),
    collections: [collection(107)],
  })
  fixture.state.commitThenThrow = true
  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: inputC,
    now: NOW + 1,
    publicationId: 'workflow-c',
  }), /commit response loss/)
  fixture.state.commitThenThrow = false

  const replay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: inputC,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })
  assert.equal(replay.status, 'published')
  assert.equal(replay.generation, 12)
  assert.equal(fixture.state.allocations, 2)
})

test('overlapping attempts for the same publication identity cannot rewrite an older generation', async () => {
  const fixture = await changedFixture()
  const newerInput = await publicationInput({
    ...emptyInput(),
    collections: [collection(100)],
  })
  let notifyBlocked!: () => void
  let releaseFirst!: () => void
  const blocked = new Promise<void>((resolve) => { notifyBlocked = resolve })
  const release = new Promise<void>((resolve) => { releaseFirst = resolve })
  fixture.pointerKv.beforePut = async () => {
    notifyBlocked()
    await release
  }

  const firstPublication = publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-a',
  })
  await blocked

  const replay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-a',
  })
  const newerWhileBlocked = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: newerInput,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })
  releaseFirst()
  const first = await firstPublication
  await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: newerInput,
    now: NOW + 1,
    publicationId: 'workflow-c',
  })

  assert.equal(replay.status, 'pending')
  assert.equal(replay.pointerPuts, 0)
  assert.equal(newerWhileBlocked.status, 'pending')
  assert.equal(newerWhileBlocked.pointerPuts, 0)
  assert.equal(first.status, 'published')
  assert.deepEqual(
    fixture.pointerKv.putValues.map((value) => JSON.parse(value).generation),
    [12, 13],
  )
})

test('an expired same-identity attempt is fenced after takeover and cannot rewrite after the next generation', async () => {
  const fixture = await changedFixture()
  const newerInput = await publicationInput({
    ...emptyInput(),
    collections: [collection(101)],
  })
  let notifyBlocked!: () => void
  let releaseExpired!: () => void
  const blocked = new Promise<void>((resolve) => { notifyBlocked = resolve })
  const release = new Promise<void>((resolve) => { releaseExpired = resolve })
  fixture.state.beforeConfirm = async () => {
    notifyBlocked()
    await release
  }

  const expiredAttempt = publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-expiry',
  })
  await blocked
  fixture.state.advanceLeaseClock(61)

  const takeover = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-expiry',
  })
  const newer = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: newerInput,
    now: NOW + 1,
    publicationId: 'workflow-next',
  })
  releaseExpired()
  const expired = await expiredAttempt

  assert.equal(takeover.status, 'published')
  assert.equal(newer.status, 'published')
  assert.equal(expired.status, 'pending')
  assert.equal(expired.pointerPuts, 0)
  assert.deepEqual(
    fixture.pointerKv.putValues.map((value) => JSON.parse(value).generation),
    [12, 13],
  )
})

test('claim response loss and crash before KV are replayable by the same durable publication identity', async () => {
  const fixture = await changedFixture()
  fixture.state.claimThenThrow = true

  await assert.rejects(() => publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-replay',
  }), /claim response loss/)
  assert.equal(fixture.pointerKv.putValues.length, 0)

  const differentRun = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-other',
  })
  assert.equal(differentRun.status, 'pending')
  assert.equal(differentRun.pointerPuts, 0)

  const preExpiryReplay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-replay',
  })
  assert.equal(preExpiryReplay.status, 'pending')
  assert.equal(preExpiryReplay.pointerPuts, 0)

  fixture.state.advanceLeaseClock(61)
  const postExpiryReplay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-replay',
  })
  assert.equal(postExpiryReplay.status, 'published')
  assert.equal(postExpiryReplay.pointerPuts, 1)
})

test('release failure retains a replayable claim for the same durable publication identity', async () => {
  const fixture = await changedFixture()
  fixture.pointerKv.mode = 'throw-before'
  fixture.state.failRelease = true

  const first = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-release-replay',
  })
  assert.equal(first.status, 'pending')
  assert.equal(first.pointerPuts, 0)

  fixture.pointerKv.mode = 'normal'
  fixture.state.failRelease = false
  const preExpiryReplay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-release-replay',
  })
  assert.equal(preExpiryReplay.status, 'pending')
  assert.equal(preExpiryReplay.pointerPuts, 0)

  fixture.state.advanceLeaseClock(61)
  const postExpiryReplay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW,
    publicationId: 'workflow-release-replay',
  })
  assert.equal(postExpiryReplay.status, 'published')
  assert.equal(postExpiryReplay.pointerPuts, 1)
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
    publicationId: 'workflow-definite-kv',
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
    publicationId: 'workflow-ambiguous-exact',
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
        publicationId: `workflow-ambiguous-${mode}`,
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
    publicationId: 'workflow-ambiguous-readback',
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.pointerPuts, 0)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.events.includes('d1:mark-published'), false)

  fixture.pointerKv.mode = 'normal'
  fixture.pointerKv.failReadback = false
  const replay = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW + 1,
    publicationId: 'workflow-ambiguous-readback',
  })
  assert.equal(replay.status, 'published')
  assert.equal(replay.pointerPuts, 1)
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
    publicationId: 'workflow-pending-replay',
  })
  const pending = structuredClone(fixture.state.pending!)
  fixture.pointerKv.mode = 'normal'
  const second = await publishPublicSnapshot({
    state: fixture.state,
    dataBucket: fixture.dataBucket,
    pointerKv: fixture.pointerKv,
    input: fixture.input,
    now: NOW + 600,
    publicationId: 'workflow-pending-replay',
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
    publicationId: 'workflow-mark-response-loss',
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
    publicationId: 'workflow-mark-failure',
  })

  assert.equal(result.status, 'pending')
  assert.equal(result.pointerPuts, 1)
  assert.equal(fixture.state.pending?.generation, 12)
  assert.equal(fixture.state.verified, fixture.oldPointer)
})
