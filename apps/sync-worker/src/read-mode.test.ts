import assert from 'node:assert/strict'
import test from 'node:test'
import {
  migrateKvBudgetDailyKey,
  type KvBudgetDailyV1,
} from '@airing-cal/storage'
import {
  recordDailyKvBudget,
  shadowGatePassed,
  updateShadowStreak,
  type ShadowGateD1,
} from './read-mode.ts'

const now = 1_785_104_400

class FakeShadowD1 implements ShadowGateD1 {
  appState = new Map<string, { version: number; value: unknown }>()

  async getAppState<T>(key: string, decode: (value: unknown) => T): Promise<T | undefined> {
    const entry = this.appState.get(key)
    return entry === undefined ? undefined : decode(entry.value)
  }

  async putAppStateIfNewer<T>(key: string, value: T, version: number): Promise<boolean> {
    const entry = this.appState.get(key)
    if (entry === undefined || version >= entry.version) {
      this.appState.set(key, { version, value: structuredClone(value) })
      return true
    }
    return false
  }
}

test('equal comparisons advance the streak and record success time', async () => {
  const store = new FakeShadowD1()

  const first = await updateShadowStreak(store, true, null, now)
  const second = await updateShadowStreak(store, true, null, now + 1)

  assert.equal(first.streak, 1)
  assert.equal(second.streak, 2)
  assert.equal(second.last_success_at, now + 1)
})

test('a business difference resets the streak and stores the diff summary', async () => {
  const store = new FakeShadowD1()
  await updateShadowStreak(store, true, null, now)
  await updateShadowStreak(store, true, null, now + 1)

  const reset = await updateShadowStreak(store, false, 'snapshot.collections.watched[0].name', now + 2)

  assert.equal(reset.streak, 0)
  assert.equal(reset.last_diff_summary, 'snapshot.collections.watched[0].name')
  assert.equal(reset.last_success_at, now + 1)
})

test('gate requires seven consecutive successes and seven days within the KV budget', async () => {
  const store = new FakeShadowD1()
  await updateShadowStreak(store, true, null, now)
  for (let index = 0; index < 6; index++) {
    await updateShadowStreak(store, true, null, now + index + 1)
  }
  for (let offset = 0; offset < 7; offset++) {
    await recordDailyKvBudget(store, dateAtOffset('2026-07-31', -offset), 0, now)
  }

  assert.equal(await shadowGatePassed(store, '2026-07-31', now), true)
})

test('gate rejects a six-day streak', async () => {
  const store = new FakeShadowD1()
  for (let index = 0; index < 6; index++) {
    await updateShadowStreak(store, true, null, now + index)
  }
  for (let offset = 0; offset < 7; offset++) {
    await recordDailyKvBudget(store, dateAtOffset('2026-07-31', -offset), 0, now)
  }

  assert.equal(await shadowGatePassed(store, '2026-07-31', now), false)
})

test('gate rejects any day over one hundred legacy subject KV writes', async () => {
  const store = new FakeShadowD1()
  for (let index = 0; index < 7; index++) {
    await updateShadowStreak(store, true, null, now + index)
  }
  for (let offset = 0; offset < 7; offset++) {
    await recordDailyKvBudget(store, dateAtOffset('2026-07-31', -offset), offset === 2 ? 101 : 0, now)
  }

  assert.equal(await shadowGatePassed(store, '2026-07-31', now), false)
})

function dateAtOffset(date: string, offsetDays: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day))
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return value.toISOString().slice(0, 10)
}

test('a newer budget record replaces an older one', async () => {
  const store = new FakeShadowD1()

  await recordDailyKvBudget(store, '2026-07-31', 10, now)
  await recordDailyKvBudget(store, '2026-07-31', 3, now + 1)

  const budget = await store.getAppState(
    migrateKvBudgetDailyKey('2026-07-31'),
    (value) => value as KvBudgetDailyV1,
  )
  assert.equal(budget?.legacy_subject_kv_writes, 3)
})
