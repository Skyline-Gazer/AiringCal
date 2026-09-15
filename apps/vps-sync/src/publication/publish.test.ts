import assert from 'node:assert/strict'
import test from 'node:test'
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { buildManifest, buildPublicSnapshot, canonicalSnapshotBytes, parsePublicSnapshotManifestV1, parsePublicSnapshotV1, snapshotKey } from '@airing-cal/domain'
import { canonicalJson, type PublicCollectionItemV1, type PublicSnapshotV1 } from '@airing-cal/storage'
import type { Publication, PublicationState } from '../postgres/repositories.js'
import { publishSnapshot, type PublicationCandidate, type PublicationPorts } from './publish.js'
import { createS3Port } from './s3.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const candidateGitSha = 'b'.repeat(40)
const previousGitSha = 'a'.repeat(40)

function collectionItem(name: string): PublicCollectionItemV1 {
  return {
    subject_id: 1,
    name,
    name_cn: '',
    summary: '',
    images: { common: null, large: null },
    image_status: { common: 'missing_source', large: 'missing_source' },
    eps: 0,
    total_episodes: 0,
    ep_status: 0,
    vol_status: 0,
    type: 2,
    collection_type: 1,
    rate: 0,
    nsfw: false,
    date: '',
    tags: [],
    updated_at: '2026-09-15T00:00:00Z',
  }
}

async function snapshot(name: string, publishedAt: number, generation = 0): Promise<PublicSnapshotV1> {
  return buildPublicSnapshot({ collections: [collectionItem(name)], calendar: [], published_at: publishedAt }, generation)
}

function publication(snapshotValue: PublicSnapshotV1, generation: number, runId: string, observedAt: number, gitSha: string): Publication {
  return {
    generation,
    content_hash: snapshotValue.content_hash,
    object_key: snapshotKey(generation, snapshotValue.content_hash),
    published_at: snapshotValue.published_at,
    observed_at: observedAt,
    run_id: runId,
    item_count: snapshotValue.summary._total,
    git_sha: gitSha,
  }
}

function manifestBytes(snapshotValue: PublicSnapshotV1, saved: Publication): Uint8Array {
  const completeSnapshot = { ...snapshotValue, generation: saved.generation, published_at: saved.published_at }
  return encoder.encode(canonicalJson(buildManifest(completeSnapshot, {
    source_observed_at: saved.observed_at,
    git_sha: saved.git_sha,
  })))
}

type Fault = {
  op: 'get' | 'put'
  key: string
  occurrence: number
  mode?: 'throw' | 'corrupt' | 'after'
}

function memoryS3(events: string[], initial: Record<string, Uint8Array>, fault?: Fault) {
  const objects = new Map(Object.entries(initial).map(([key, bytes]) => [key, bytes.slice()]))
  const gets = new Map<string, number>()
  const puts = new Map<string, number>()
  const matches = (op: Fault['op'], key: string, occurrence: number) => fault?.op === op && fault.key === key && fault.occurrence === occurrence
  return {
    objects,
    port: {
      put: async (key: string, bytes: Uint8Array, options?: { ifNoneMatch?: '*' }) => {
        events.push(`s3:put:${key}`)
        const occurrence = (puts.get(key) ?? 0) + 1
        puts.set(key, occurrence)
        const injected = matches('put', key, occurrence)
        if (injected && fault?.mode !== 'after') throw new Error('injected R2 PUT failure')
        if (options?.ifNoneMatch === '*' && objects.has(key)) return
        objects.set(key, bytes.slice())
        if (injected) throw new Error('injected ambiguous R2 PUT failure')
      },
      get: async (key: string) => {
        events.push(`s3:get:${key}`)
        const occurrence = (gets.get(key) ?? 0) + 1
        gets.set(key, occurrence)
        if (matches('get', key, occurrence) && fault?.mode === 'throw') throw new Error('injected R2 GET failure')
        if (matches('get', key, occurrence) && fault?.mode === 'corrupt') return encoder.encode('{}')
        return objects.get(key)?.slice() ?? null
      },
      list: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)).sort(),
      delete: async (key: string) => { objects.delete(key) },
    },
  }
}

function memoryAuthority(events: string[], initial: PublicationState, failVerify = false) {
  let state = structuredClone(initial)
  const authority = {
    getPublicationState: async () => {
      events.push('db:state')
      return structuredClone(state)
    },
    savePendingPublication: async (value: Publication, claim: 'keep' | 'claim' | 'release' = 'keep') => {
      events.push(`db:${claim}:${value.generation}`)
      if (state.verified?.content_hash === value.content_hash) {
        return { outcome: 'no_change' as const, publication: state.verified }
      }
      const exact = state.pending !== null && JSON.stringify(state.pending) === JSON.stringify(value)
      if (state.claimed && !exact) throw new Error('PUBLICATION_CLAIMED')
      if (state.pending && !state.claimed && (state.pending.generation !== value.generation)) throw new Error('GENERATION_CONFLICT')
      state = { ...state, pending: value, claimed: claim === 'claim' || (claim === 'keep' && exact && state.claimed) }
      return { outcome: exact ? 'replay' as const : 'pending' as const, publication: value }
    },
    verifyPublication: async (value: Publication) => {
      events.push(`db:verify:${value.generation}`)
      if (failVerify) throw new Error('injected database verification failure')
      assert.equal(state.claimed, true)
      assert.deepEqual(state.pending, value)
      state = { verified: value, pending: null, claimed: false }
      return 'verified' as const
    },
  }
  return { authority, getState: () => structuredClone(state) }
}

async function liveFixture(fault?: Fault, failVerify = false) {
  const oldSnapshot = await snapshot('previous', 100, 1)
  const newSnapshot = await snapshot('next', 200)
  const verified = publication(oldSnapshot, 1, 'run-old', 150, previousGitSha)
  const candidate: PublicationCandidate = {
    snapshot: newSnapshot,
    runId: 'run-live-1',
    observedAt: 300,
    gitSha: candidateGitSha,
  }
  const oldManifest = manifestBytes(oldSnapshot, verified)
  const events: string[] = []
  const s3 = memoryS3(events, {
    [verified.object_key]: canonicalSnapshotBytes({ ...oldSnapshot, generation: verified.generation }),
    'public/manifest.json': oldManifest,
  }, fault)
  const database = memoryAuthority(events, { verified, pending: null, claimed: false }, failVerify)
  const ports: PublicationPorts = { authority: database.authority, s3: s3.port }
  return { ports, events, objects: s3.objects, database, candidate, verified, oldManifest, snapshotPath: snapshotKey(2, newSnapshot.content_hash) }
}

test('live publication verifies snapshot readback before manifest and database promotion', async () => {
  const fixture = await liveFixture()
  assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'published')
  assert.deepEqual(fixture.events, [
    'db:state',
    'db:claim:2',
    's3:get:public/manifest.json',
    `s3:put:${fixture.snapshotPath}`,
    `s3:get:${fixture.snapshotPath}`,
    's3:put:public/manifest.json',
    's3:get:public/manifest.json',
    'db:verify:2',
  ])
  assert.ok(fixture.objects.has(fixture.snapshotPath))
  const manifest = parsePublicSnapshotManifestV1(JSON.parse(decoder.decode(fixture.objects.get('public/manifest.json'))))
  assert.equal(manifest.generation, 2)
  assert.equal(manifest.content_sha256, fixture.candidate.snapshot.content_hash)
})

test('each publication boundary failure keeps the old live manifest and claimed pending generation', async (t) => {
  const base = await liveFixture()
  const scenarios: Array<[string, Fault]> = [
    ['old manifest GET', { op: 'get', key: 'public/manifest.json', occurrence: 1, mode: 'throw' }],
    ['snapshot PUT', { op: 'put', key: base.snapshotPath, occurrence: 1, mode: 'throw' }],
    ['snapshot PUT after an ambiguous successful write', { op: 'put', key: base.snapshotPath, occurrence: 1, mode: 'after' }],
    ['snapshot GET', { op: 'get', key: base.snapshotPath, occurrence: 1, mode: 'throw' }],
    ['snapshot readback validation', { op: 'get', key: base.snapshotPath, occurrence: 1, mode: 'corrupt' }],
    ['manifest PUT after an ambiguous successful write', { op: 'put', key: 'public/manifest.json', occurrence: 1, mode: 'after' }],
    ['manifest readback GET', { op: 'get', key: 'public/manifest.json', occurrence: 2, mode: 'throw' }],
    ['manifest readback validation', { op: 'get', key: 'public/manifest.json', occurrence: 2, mode: 'corrupt' }],
  ]
  for (const [name, fault] of scenarios) {
    await t.test(name, async () => {
      const fixture = await liveFixture(fault)
      assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'pending')
      assert.deepEqual(fixture.objects.get('public/manifest.json'), fixture.oldManifest)
      const state = fixture.database.getState()
      assert.equal(state.claimed, true)
      assert.equal(state.pending?.generation, 2)
      assert.equal(state.pending?.content_hash, fixture.candidate.snapshot.content_hash)
      assert.deepEqual(state.verified, fixture.verified)
      assert.equal(fixture.events.includes('db:verify:2'), false)
    })
  }
  await t.test('database promotion failure restores the old manifest and retains pending', async () => {
    const fixture = await liveFixture(undefined, true)
    assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'pending')
    assert.deepEqual(fixture.objects.get('public/manifest.json'), fixture.oldManifest)
    assert.equal(fixture.database.getState().pending?.generation, 2)
    assert.equal(fixture.database.getState().claimed, true)
  })
})

test('retrying the same claimed pending publication reuses its generation', async () => {
  const retrySnapshot = await snapshot('next', 200)
  const retryKey = snapshotKey(2, retrySnapshot.content_hash)
  const fixture = await liveFixture({ op: 'put', key: retryKey, occurrence: 1, mode: 'after' })
  assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'pending')
  const firstPending = fixture.database.getState().pending
  assert.equal(firstPending?.generation, 2)
  assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'published')
  assert.equal(fixture.database.getState().verified?.generation, 2)
  assert.equal(fixture.database.getState().pending, null)
  assert.equal(fixture.events.filter((event) => event.startsWith('s3:put:snapshots/v1/')).length, 2)
  assert.ok(fixture.objects.has('snapshots/v1/2-' + fixture.candidate.snapshot.content_hash + '.json'))
})

test('an existing immutable snapshot key is never overwritten', async () => {
  const fixture = await liveFixture()
  const priorBytes = encoder.encode('unexpected existing object bytes')
  fixture.objects.set(fixture.snapshotPath, priorBytes)
  assert.equal(await publishSnapshot(fixture.ports, fixture.candidate, 'live'), 'pending')
  assert.deepEqual(fixture.objects.get(fixture.snapshotPath), priorBytes)
  assert.deepEqual(fixture.objects.get('public/manifest.json'), fixture.oldManifest)
  assert.equal(fixture.database.getState().pending?.generation, 2)
})

test('unchanged live content performs no R2 writes', async () => {
  const oldSnapshot = await snapshot('previous', 100, 1)
  const verified = publication(oldSnapshot, 1, 'run-old', 150, previousGitSha)
  const events: string[] = []
  const database = memoryAuthority(events, { verified, pending: null, claimed: false })
  const s3 = memoryS3(events, {})
  const ports: PublicationPorts = { authority: database.authority, s3: s3.port }
  assert.equal(await publishSnapshot(ports, { snapshot: oldSnapshot, runId: 'run-live-2', observedAt: 400, gitSha: candidateGitSha }, 'live'), 'no_change')
  assert.deepEqual(events, ['db:state', 'db:keep:1'])
})

test('shadow publication writes only shadow snapshot and manifest keys', async () => {
  const candidate: PublicationCandidate = { snapshot: await snapshot('shadow', 200), runId: 'run-shadow-1', observedAt: 300, gitSha: candidateGitSha }
  const events: string[] = []
  const database = memoryAuthority(events, { verified: null, pending: null, claimed: false })
  const s3 = memoryS3(events, {})
  const ports: PublicationPorts = { authority: database.authority, s3: s3.port }

  assert.equal(await publishSnapshot(ports, candidate, 'shadow'), 'published')
  assert.ok(events.includes('s3:put:shadow/manifest.json'))
  assert.ok(events.filter((event) => event.startsWith('s3:put:')).every((event) => event.startsWith('s3:put:shadow/')))
  assert.equal(events.some((event) => event.includes('public/manifest.json')), false)
  assert.equal(events.some((event) => event.startsWith('db:claim:') || event.startsWith('db:verify:')), false)
  const manifest = parsePublicSnapshotManifestV1(JSON.parse(decoder.decode(s3.objects.get('shadow/manifest.json'))))
  assert.equal(manifest.snapshot_key, snapshotKey(1, candidate.snapshot.content_hash))
  assert.deepEqual(s3.objects.get(`shadow/${manifest.snapshot_key}`), canonicalSnapshotBytes({
    ...candidate.snapshot,
    generation: manifest.generation,
  }))
  assert.deepEqual(await parsePublicSnapshotV1(JSON.parse(decoder.decode(s3.objects.get(`shadow/${manifest.snapshot_key}`)))), {
    ...candidate.snapshot,
    generation: manifest.generation,
  })
})

test('shadow R2 boundary failures retain the old shadow manifest and never touch live keys', async (t) => {
  const oldSnapshot = await snapshot('old-shadow', 100, 1)
  const candidateSnapshot = await snapshot('new-shadow', 200)
  const oldPublication = publication(oldSnapshot, 1, 'run-shadow-old', 150, previousGitSha)
  const candidate: PublicationCandidate = {
    snapshot: candidateSnapshot,
    runId: 'run-shadow-new',
    observedAt: 300,
    gitSha: candidateGitSha,
  }
  const oldManifest = manifestBytes(oldSnapshot, oldPublication)
  const objectKey = `shadow/${snapshotKey(2, candidateSnapshot.content_hash)}`
  const scenarios: Array<[string, Fault]> = [
    ['old manifest GET', { op: 'get', key: 'shadow/manifest.json', occurrence: 1, mode: 'throw' }],
    ['snapshot PUT', { op: 'put', key: objectKey, occurrence: 1, mode: 'throw' }],
    ['snapshot GET', { op: 'get', key: objectKey, occurrence: 1, mode: 'throw' }],
    ['snapshot readback validation', { op: 'get', key: objectKey, occurrence: 1, mode: 'corrupt' }],
    ['manifest PUT after an ambiguous successful write', { op: 'put', key: 'shadow/manifest.json', occurrence: 1, mode: 'after' }],
    ['manifest readback GET', { op: 'get', key: 'shadow/manifest.json', occurrence: 2, mode: 'throw' }],
    ['manifest readback validation', { op: 'get', key: 'shadow/manifest.json', occurrence: 2, mode: 'corrupt' }],
  ]
  for (const [name, fault] of scenarios) {
    await t.test(name, async () => {
      const events: string[] = []
      const s3 = memoryS3(events, { 'shadow/manifest.json': oldManifest }, fault)
      const database = memoryAuthority(events, { verified: null, pending: null, claimed: false })
      assert.equal(await publishSnapshot({ authority: database.authority, s3: s3.port }, candidate, 'shadow'), 'pending')
      assert.deepEqual(s3.objects.get('shadow/manifest.json'), oldManifest)
      assert.equal(events.some((event) => event.includes('public/manifest.json')), false)
      assert.equal(events.some((event) => event.startsWith('db:')), false)
    })
  }
})

test('S3 port issues verified PUT, GET, paginated LIST, and DELETE commands', async () => {
  const commands: Array<PutObjectCommand | GetObjectCommand | ListObjectsV2Command | DeleteObjectCommand> = []
  const responses: unknown[] = [
    {},
    { Body: { transformToByteArray: async () => new Uint8Array([4, 5]) } },
    { Contents: [{ Key: 'snapshots/one' }], IsTruncated: true, NextContinuationToken: 'next' },
    { Contents: [{ Key: 'snapshots/two' }], IsTruncated: false },
    {},
  ]
  const client = {
    send: async (command: PutObjectCommand | GetObjectCommand | ListObjectsV2Command | DeleteObjectCommand) => {
      commands.push(command)
      return responses.shift()
    },
  } as unknown as S3Client
  const port = createS3Port({ bucket: 'test-bucket', endpoint: 'https://account.r2.cloudflarestorage.com', accessKeyId: 'key', secretAccessKey: 'secret' }, client)
  await port.put('snapshots/body.json', new Uint8Array([1, 2, 3]), { ifNoneMatch: '*' })
  assert.deepEqual(await port.get('snapshots/body.json'), new Uint8Array([4, 5]))
  assert.deepEqual(await port.list('snapshots/'), ['snapshots/one', 'snapshots/two'])
  await port.delete('snapshots/body.json')

  assert.ok(commands[0] instanceof PutObjectCommand)
  assert.equal(commands[0]?.input.Bucket, 'test-bucket')
  assert.equal(commands[0]?.input.Key, 'snapshots/body.json')
  assert.deepEqual(commands[0]?.input.Body, new Uint8Array([1, 2, 3]))
  assert.equal(commands[0]?.input.IfNoneMatch, '*')
  assert.ok(commands[1] instanceof GetObjectCommand)
  assert.ok(commands[2] instanceof ListObjectsV2Command)
  assert.ok(commands[3] instanceof ListObjectsV2Command)
  assert.equal((commands[2] as ListObjectsV2Command).input.ContinuationToken, undefined)
  assert.equal((commands[3] as ListObjectsV2Command).input.ContinuationToken, 'next')
  assert.ok(commands[4] instanceof DeleteObjectCommand)
})

test('S3 port treats R2 missing-object responses as null', async () => {
  const client = {
    send: async () => { const error = new Error('missing'); error.name = 'NoSuchKey'; throw error },
  } as unknown as S3Client
  const port = createS3Port({ bucket: 'test-bucket', endpoint: 'https://account.r2.cloudflarestorage.com', accessKeyId: 'key', secretAccessKey: 'secret' }, client)
  assert.equal(await port.get('public/manifest.json'), null)
})

test('S3 port treats conditional conflicts as immutable-object readback cases', async () => {
  const client = {
    send: async () => {
      const error = new Error('precondition failed')
      error.name = 'PreconditionFailed'
      Object.assign(error, { $metadata: { httpStatusCode: 412 } })
      throw error
    },
  } as unknown as S3Client
  const port = createS3Port({ bucket: 'test-bucket', endpoint: 'https://account.r2.cloudflarestorage.com', accessKeyId: 'key', secretAccessKey: 'secret' }, client)
  await assert.doesNotReject(() => port.put('snapshots/immutable.json', new Uint8Array([1]), { ifNoneMatch: '*' }))
  await assert.rejects(() => port.put('public/manifest.json', new Uint8Array([1])), /precondition failed/)
})
