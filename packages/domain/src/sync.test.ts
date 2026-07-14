import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareAccounts,
  executeSync,
  type AccountInfo,
  type ComparisonItem,
  type PatchEntryOptions,
  type PatchEntryResult,
  type PlatformClient,
  type PlatformId,
  WatchStatus,
} from './index.ts'

class FakeClient implements PlatformClient {
  readonly platform: PlatformId = 'bgm'
  getMeCalls = 0
  fetchedUsernames: string[] = []
  patched: Array<{ token: string; externalId: string; item: ComparisonItem; options?: PatchEntryOptions }> = []

  constructor(private username: string, private items: ComparisonItem[]) {}

  async getMe(_token: string): Promise<AccountInfo> {
    this.getMeCalls++
    return { username: this.username, externalId: this.username, platform: 'bgm' }
  }

  async fetchCollections(_token: string, username: string): Promise<ComparisonItem[]> {
    this.fetchedUsernames.push(username)
    return this.items
  }

  async patchEntry(token: string, externalId: string, item: ComparisonItem, options?: PatchEntryOptions): Promise<PatchEntryResult> {
    this.patched.push({ token, externalId, item, options })
    return { episodeChanged: Number(externalId), episodeProgress: { before: 1, after: item.progress, total: item.totalEpisodes } }
  }
}

function item(externalId: string, overrides: Partial<ComparisonItem> = {}): ComparisonItem {
  return {
    externalId,
    title: `Anime ${externalId}`,
    status: WatchStatus.WATCHING,
    progress: 1,
    totalEpisodes: 12,
    score: 7,
    platform: 'bgm',
    ...overrides,
  }
}

test('compareAccounts separates same, changed, only-source, and only-target entries', async () => {
  const source = new FakeClient('source-user', [
    item('1'),
    item('2', { score: 8 }),
    item('3'),
  ])
  const target = new FakeClient('target-user', [
    item('1'),
    item('2', { score: 6 }),
    item('4'),
  ])

  const result = await compareAccounts(source, 'source-token', target, 'target-token')

  assert.deepEqual(source.fetchedUsernames, ['source-user'])
  assert.deepEqual(target.fetchedUsernames, ['target-user'])
  assert.equal(result.common, 2)
  assert.deepEqual(result.same.map((entry) => entry.externalId), ['1'])
  assert.deepEqual(result.differences.map((entry) => entry.externalId), ['2'])
  assert.deepEqual(result.onlyA.map((entry) => entry.externalId), ['3'])
  assert.deepEqual(result.onlyB.map((entry) => entry.externalId), ['4'])
  assert.equal(result.differences[0]?.itemA?.status, WatchStatus.WATCHING)
  assert.equal(result.differences[0]?.itemB?.score, 6)
  assert.equal(result.onlyA[0]?.itemA?.externalId, '3')
  assert.equal(result.onlyB[0]?.itemB?.externalId, '4')
})

test('executeSync patches partial entries and reports baseline field changes', async () => {
  const source = new FakeClient('source-user', [
    item('8', { status: WatchStatus.COMPLETED, progress: 8, score: 9 }),
    item('9'),
  ])
  const target = new FakeClient('target-user', [])

  const results = await executeSync(source, 'source-token', target, 'target-token', {
    mode: 'partial',
    from: 'source label',
    to: 'target label',
    subject_ids: ['8'],
    baseline: [{ externalId: '8', status: WatchStatus.WATCHING, score: 7, progress: 1, totalEpisodes: 12 }],
  })

  assert.deepEqual(target.patched.map((call) => call.externalId), ['8'])
  assert.equal(target.patched[0]?.token, 'target-token')
  assert.equal(target.patched[0]?.options?.sourceToken, 'source-token')
  assert.deepEqual(results[0]?.collectionStatus, { before: '在看', after: '看过' })
  assert.deepEqual(results[0]?.scoreChange, { before: 7, after: 9 })
  assert.deepEqual(results[0]?.episodeProgress, { before: 1, after: 8, total: 12 })
})

test('executeSync applies validated items without refetching source collections', async () => {
  const source = new FakeClient('source-user', [item('unused')])
  const target = new FakeClient('target-user', [])

  const results = await executeSync(source, 'source-token', target, 'target-token', {
    mode: 'partial',
    from: 'source label',
    to: 'target label',
    items: [item('8', { status: WatchStatus.COMPLETED, progress: 8, score: 9 })],
    baseline: [{ externalId: '8', status: WatchStatus.WATCHING, score: 7, progress: 1, totalEpisodes: 12 }],
  })

  assert.equal(source.getMeCalls, 0)
  assert.deepEqual(source.fetchedUsernames, [])
  assert.deepEqual(target.patched.map((call) => call.externalId), ['8'])
  assert.equal(results[0]?.status, 'ok')
})

test('executeSync rejects more than five items before any platform call', async () => {
  const source = new FakeClient('source-user', [])
  const target = new FakeClient('target-user', [])

  await assert.rejects(() => executeSync(source, 'source-token', target, 'target-token', {
    mode: 'partial',
    from: 'source label',
    to: 'target label',
    items: Array.from({ length: 6 }, (_, index) => item(String(index + 1))),
  }), /at most 5 items/)
  assert.equal(source.getMeCalls, 0)
  assert.deepEqual(source.fetchedUsernames, [])
  assert.deepEqual(target.patched, [])
})

test('executeSync limits legacy subject_ids to five entries', async () => {
  const source = new FakeClient('source-user', [])
  const target = new FakeClient('target-user', [])

  await assert.rejects(() => executeSync(source, 'source-token', target, 'target-token', {
    mode: 'partial',
    from: 'source label',
    to: 'target label',
    subject_ids: Array.from({ length: 6 }, (_, index) => String(index + 1)),
  }), /at most 5 subject_ids/)
  assert.equal(source.getMeCalls, 0)
})
