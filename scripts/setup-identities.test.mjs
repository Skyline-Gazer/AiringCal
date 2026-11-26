import assert from 'node:assert/strict'
import test from 'node:test'
import {
  IdentityError,
  deriveUsersConfig,
  fetchCloudflareAccounts,
  fetchDnsRecordsForName,
  fetchWorkersSubdomain,
  fetchZones,
  resolveBangumiIdentity,
  verifyCloudflareToken,
} from './setup-identities.mjs'

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const { status = 200, body = { success: true, result: null } } = handler(String(url), init) ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }
  return { impl, calls }
}

const ACCOUNT = 'abcdef0123456789abcdef0123456789'

test('verifyCloudflareToken accepts active tokens and rejects inactive ones (#195)', async () => {
  const ok = fakeFetch(() => ({ body: { success: true, result: { status: 'active', id: 'tok-id' } } }))
  assert.deepEqual(await verifyCloudflareToken(ok.impl, 'secret'), { status: 'active', tokenId: 'tok-id' })
  const bad = fakeFetch(() => ({ body: { success: true, result: { status: 'pending' } } }))
  await assert.rejects(() => verifyCloudflareToken(bad.impl, 'secret'), (error) => {
    assert.equal(error.code, 'CF_TOKEN_INACTIVE')
    return true
  })
})

test('fetchCloudflareAccounts selects the eligible accounts and refuses none (#195)', async () => {
  const one = fakeFetch(() => ({
    body: { success: true, result: [{ id: ACCOUNT, name: 'Main' }, { id: 'not-an-account', name: 'Bad' }] },
  }))
  assert.deepEqual(await fetchCloudflareAccounts(one.impl, 'tok'), [{ id: ACCOUNT, name: 'Main' }])
  const none = fakeFetch(() => ({ body: { success: true, result: [] } }))
  await assert.rejects(() => fetchCloudflareAccounts(none.impl, 'tok'), (error) => {
    assert.equal(error.code, 'CF_NO_ACCOUNTS')
    return true
  })
})

test('fetchCloudflareAccounts maps 401/403 to a stable unauthorized code without leaking the token (#195)', async () => {
  const denied = fakeFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] } }))
  await assert.rejects(() => fetchCloudflareAccounts(denied.impl, 'super-secret-token'), (error) => {
    assert.equal(error.code, 'CF_UNAUTHORIZED')
    assert.equal(error.message.includes('super-secret-token'), false)
    return true
  })
})

test('fetchWorkersSubdomain returns the real subdomain, never a guess (#195)', async () => {
  const ok = fakeFetch(() => ({ body: { success: true, result: { subdomain: 'acme' } } }))
  assert.equal(await fetchWorkersSubdomain(ok.impl, 'tok', ACCOUNT), 'acme')
  const missing = fakeFetch(() => ({ body: { success: true, result: {} } }))
  await assert.rejects(() => fetchWorkersSubdomain(missing.impl, 'tok', ACCOUNT), (error) => {
    assert.equal(error.code, 'CF_NO_WORKERS_SUBDOMAIN')
    return true
  })
})

test('fetchZones pages and normalizes zone identity (#195)', async () => {
  const fake = fakeFetch((url) => {
    const page = Number(new URL(url).searchParams.get('page'))
    if (page === 1) {
      return { body: { success: true, result: Array.from({ length: 50 }, (_, i) => ({ id: `z${i}`, name: `z${i}.example`, status: 'active' })) } }
    }
    return { body: { success: true, result: [{ id: 'z-last', name: 'last.example', status: 'active' }] } }
  })
  const zones = await fetchZones(fake.impl, 'tok', ACCOUNT)
  assert.equal(zones.length, 51)
  assert.deepEqual(zones[51 - 1], { id: 'z-last', name: 'last.example', status: 'active' })
  assert.equal(fake.calls[0].url.includes(`account.id=${ACCOUNT}`), true)
})

test('fetchDnsRecordsForName reports occupancy for takeover detection (#195)', async () => {
  const occupied = fakeFetch(() => ({
    body: {
      success: true,
      result: [
        { id: 'r1', name: 'Anime.Example.com', type: 'CNAME', content: 'other.workers.dev' },
        { id: 'r2', name: 'unrelated.example.com', type: 'A', content: '1.2.3.4' },
      ],
    },
  }))
  const records = await fetchDnsRecordsForName(occupied.impl, 'tok', 'zone-1', 'anime.example.com')
  assert.equal(records.length, 1)
  assert.equal(records[0].type, 'CNAME')
})

test('resolveBangumiIdentity derives userId/username and gives actionable PAT diagnostics (#195)', async () => {
  const ok = fakeFetch(() => ({ body: { id: 857123, username: 'owner' } }))
  assert.deepEqual(await resolveBangumiIdentity(ok.impl, 'pat'), { userId: '857123', username: 'owner' })
  assert.equal(ok.calls[0].url, 'https://api.bgm.tv/v0/me')
  assert.equal(ok.calls[0].init.headers.Authorization, 'Bearer pat')

  const rejected = fakeFetch(() => ({ status: 401, body: {} }))
  await assert.rejects(() => resolveBangumiIdentity(rejected.impl, 'pat'), (error) => {
    assert.equal(error.code, 'BGM_PAT_REJECTED')
    assert.match(error.message, /access-token/i)
    return true
  })
  const badBody = fakeFetch(() => ({ body: { id: 'x', username: '' } }))
  await assert.rejects(() => resolveBangumiIdentity(badBody.impl, 'pat'), (error) => {
    assert.equal(error.code, 'BGM_BAD_RESPONSE')
    return true
  })
})

test('deriveUsersConfig matches the Writer schema and rejects duplicates (#195)', () => {
  const json = deriveUsersConfig({ userId: '857123', username: 'owner' })
  assert.deepEqual(JSON.parse(json), [{ userId: '857123', username: 'owner' }])
  const multi = deriveUsersConfig(
    { userId: '1', username: 'a' },
    { extraUsers: [{ userId: '2', username: 'b' }] },
  )
  assert.equal(JSON.parse(multi).length, 2)
  assert.throws(
    () => deriveUsersConfig({ userId: '1', username: 'a' }, { extraUsers: [{ userId: '1', username: 'dup' }] }),
    (error) => error instanceof IdentityError && error.code === 'USERS_CONFIG_INVALID',
  )
})
