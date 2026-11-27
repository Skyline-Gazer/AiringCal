import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareVersions,
  discoverUpdateState,
  formatUpdateState,
  latestStableRelease,
  parseVersion,
  planUpdate,
  satisfiesRange,
  toolchainBlockers,
  upgradeWorkspace,
} from './update-plan.mjs'

test('parseVersion accepts release tags but rejects junk', () => {
  assert.deepEqual(parseVersion('v3.0.0'), { major: 3, minor: 0, patch: 0, prerelease: [] })
  assert.deepEqual(parseVersion('3.0.0-rc.1'), { major: 3, minor: 0, patch: 0, prerelease: ['rc', '1'] })
  assert.equal(parseVersion('main'), null)
  assert.equal(parseVersion('3.0'), null)
  assert.equal(parseVersion(undefined), null)
})

test('compareVersions follows semver precedence', () => {
  assert.equal(compareVersions('v3.0.0', '3.0.0'), 0)
  assert.equal(compareVersions('3.0.1', '3.0.0'), 1)
  assert.equal(compareVersions('3.0.0-rc.1', '3.0.0'), -1)
  assert.equal(compareVersions('3.0.0-rc.2', '3.0.0-rc.1'), 1)
  assert.equal(compareVersions('3.0.0-alpha', '3.0.0-beta'), -1)
  assert.equal(compareVersions('nope', '3.0.0'), null)
})

test('latestStableRelease ignores drafts, prereleases and malformed tags', () => {
  const latest = latestStableRelease([
    { tag: 'v3.1.0', prerelease: true },
    { tag: 'v3.2.0', draft: true },
    { tag: 'nightly' },
    { tag: 'v3.0.0' },
    { tag: 'v2.9.9' },
  ])
  assert.equal(latest.tag, 'v3.0.0')
  assert.equal(latestStableRelease([]), null)
  assert.equal(latestStableRelease(null), null)
})

test('planUpdate separates upgrade, redeploy, current and blocked', () => {
  assert.equal(planUpdate({ localVersion: '3.0.0', targetTag: 'v3.1.0', dirty: false }).action, 'upgrade')
  assert.equal(planUpdate({ localVersion: '3.0.0', targetTag: 'v3.1.0', dirty: true }).code, 'UPDATE_WORKSPACE_DIRTY')
  assert.equal(planUpdate({ localVersion: '3.1.0', targetTag: 'v3.1.0', dirty: true }).action, 'current')
  assert.equal(
    planUpdate({ localVersion: '3.1.0', targetTag: 'v3.1.0', writerRef: 'v3.0.0', dirty: false }).action,
    'redeploy',
  )
  assert.equal(planUpdate({ localVersion: '3.1.0', targetTag: 'v3.1.0', writerRef: 'v3.1.0' }).action, 'current')
  assert.equal(planUpdate({ localVersion: '3.2.0', targetTag: 'v3.1.0' }).code, 'UPDATE_LOCAL_AHEAD')
  assert.equal(planUpdate({ localVersion: '3.0.0', targetTag: null }).action, 'unknown')
  // The release tag is authoritative: a tag bump without a package.json bump still upgrades.
  assert.equal(
    planUpdate({ localVersion: '3.0.0', localTag: 'v3.0.0', targetTag: 'v3.0.1', dirty: false }).code,
    'UPDATE_UPGRADE',
  )
  assert.equal(
    planUpdate({ localVersion: '3.1.0', localTag: 'v3.1.0', targetTag: 'v3.1.0', dirty: true }).action,
    'current',
  )
})

test('satisfiesRange understands the engine syntax this repo writes', () => {
  assert.equal(satisfiesRange('24.22.3', '>=24'), true)
  assert.equal(satisfiesRange('22.20.0', '>=24'), false)
  assert.equal(satisfiesRange('24.22.3', '>=24.0.0 <25'), true)
  assert.equal(satisfiesRange('25.0.0', '>=24.0.0 <25'), false)
  assert.equal(satisfiesRange('24.22.3', '^24'), null, 'unsupported syntax must not invent a verdict')
})

test('toolchainBlockers blocks Node but only warns on a pnpm mismatch', () => {
  const blocked = toolchainBlockers({
    pkg: { engines: { node: '>=26' }, packageManager: 'pnpm@12.23.0' },
    nodeVersion: '24.22.3',
    pnpmVersion: '9.15.9',
  })
  assert.deepEqual(blocked.map((entry) => entry.code), ['UPDATE_NODE_UNSUPPORTED', 'UPDATE_PNPM_UNSUPPORTED'])
  assert.deepEqual(blocked.map((entry) => entry.severity), ['block', 'warn'])
  assert.match(blocked[1].fix, /corepack prepare pnpm@12\.23\.0 --activate/)
  assert.deepEqual(
    toolchainBlockers({
      pkg: { engines: { node: '>=24' }, packageManager: 'pnpm@12.23.0' },
      nodeVersion: '24.22.3',
      pnpmVersion: '12.23.0',
    }),
    [],
  )
})

function fakeSpawn(routes) {
  const calls = []
  const impl = (cmd, args, options = {}) => {
    calls.push({ cmd, args, options })
    const key = `${cmd} ${args.join(' ')}`
    const route = routes[key] ?? routes[cmd]
    if (!route) return { status: 1, stderr: `unexpected command: ${key}` }
    const result = typeof route === 'function' ? route({ cmd, args, options }) : route
    return { status: 0, stdout: '', stderr: '', ...result }
  }
  impl.calls = calls
  return impl
}

const JSON_OUT = (value) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) })

test('discoverUpdateState reads the fork parent, releases, environment and reader version', async () => {
  const spawnSyncImpl = fakeSpawn({
    'git status --porcelain': JSON_OUT(''),
    'git describe --tags --exact-match --match v[0-9]*': JSON_OUT('v3.0.0'),
    'git rev-parse HEAD': JSON_OUT('a'.repeat(40)),
    'git rev-list -n 1 v3.1.0': JSON_OUT('b'.repeat(40)),
    'gh api repos/me/AiringCal --jq {parent: (.parent.full_name // "")}': JSON_OUT({ parent: 'upstream/AiringCal' }),
    'gh api repos/upstream/AiringCal/releases?per_page=50 --jq [.[] | {tag: .tag_name, draft, prerelease, publishedAt: .published_at}]': JSON_OUT([
      { tag: 'v3.1.0', draft: false, prerelease: false },
      { tag: 'v3.0.0', draft: false, prerelease: false },
    ]),
    'gh api repos/me/AiringCal/environments/production/variables --jq [.variables[] | {name, value}]': JSON_OUT([
      { name: 'AIRINGCAL_PRODUCTION_RELEASE_REF', value: 'v3.0.0' },
      { name: 'AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL', value: 'https://cal.example.com' },
    ]),
  })
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ app: 'airingcal', read: 'cloudflare', package: '3.0.0' }),
    url,
  })
  const state = await discoverUpdateState({
    environment: 'production',
    repo: 'me/AiringCal',
    spawnSyncImpl,
    fetchImpl,
    cwd: process.cwd(),
  })
  assert.equal(state.upstreamRepo, 'upstream/AiringCal')
  assert.equal(state.localVersion, '3.0.0')
  assert.equal(state.localTag, 'v3.0.0')
  assert.equal(state.target.tag, 'v3.1.0')
  assert.equal(state.target.sha, 'b'.repeat(40))
  assert.equal(state.writerRef, 'v3.0.0')
  assert.equal(state.deployedVersion, '3.0.0')
  assert.equal(state.plan.action, 'upgrade')
  const rendered = formatUpdateState(state)
  assert.match(rendered, /Target:\s+v3\.1\.0/)
  assert.match(rendered, /Action:\s+upgrade/)
})

test('discoverUpdateState keeps working when GitHub reads fail', async () => {
  const spawnSyncImpl = fakeSpawn({
    'git status --porcelain': JSON_OUT(' M docs/x.md\n'),
    'git describe --tags --exact-match --match v[0-9]*': { status: 1 },
    'git rev-parse HEAD': JSON_OUT('c'.repeat(40)),
    'gh api repos/me/AiringCal --jq {parent: (.parent.full_name // "")}': { status: 1, stderr: 'auth' },
    'gh api repos/me/AiringCal/environments/production/variables --jq [.variables[] | {name, value}]': { status: 1, stderr: 'auth' },
  })
  const state = await discoverUpdateState({
    environment: 'production',
    repo: 'me/AiringCal',
    spawnSyncImpl,
    fetchImpl: async () => { throw new Error('offline') },
    cwd: process.cwd(),
  })
  assert.equal(state.upstreamRepo, 'me/AiringCal')
  assert.equal(state.dirty, true)
  assert.equal(state.plan.action, 'unknown')
  assert.match(formatUpdateState(state), /\[uncommitted changes\]/)
  assert.match(formatUpdateState(state), /Reader:\s+unreachable/)
})

test('upgradeWorkspace fetches the tag, detaches at it and verifies the SHA', () => {
  const targetSha = 'd'.repeat(40)
  const spawnSyncImpl = fakeSpawn({
    'git rev-parse -q --verify refs/tags/v3.1.0^{commit}': { status: 1 },
    'git fetch --no-tags https://github.com/upstream/AiringCal.git refs/tags/v3.1.0:refs/tags/v3.1.0': { status: 0 },
    'git rev-parse HEAD': JSON_OUT('e'.repeat(40)),
    'git -c advice.detachedHead=false checkout --detach v3.1.0': { status: 0 },
  })
  // First rev-parse HEAD reads the previous head, the second the post-checkout head.
  let headCalls = 0
  const routed = (cmd, args, options) => {
    if (cmd === 'git' && args.join(' ') === 'rev-parse HEAD') {
      headCalls += 1
      return { status: 0, stdout: headCalls === 1 ? `${'e'.repeat(40)}\n` : `${targetSha}\n` }
    }
    return spawnSyncImpl(cmd, args, options)
  }
  routed.calls = spawnSyncImpl.calls
  const result = upgradeWorkspace({
    targetTag: 'v3.1.0',
    targetSha,
    upstreamRepo: 'upstream/AiringCal',
    spawnSyncImpl: routed,
    log: () => {},
  })
  assert.equal(result.previousHead, 'e'.repeat(40))
  assert.equal(result.headSha, targetSha)
  const checkout = spawnSyncImpl.calls.find((call) => call.args.includes('checkout'))
  assert.deepEqual(checkout.args, ['-c', 'advice.detachedHead=false', 'checkout', '--detach', 'v3.1.0'])
})

test('upgradeWorkspace refuses a conflicting local tag and a SHA mismatch', () => {
  const conflict = fakeSpawn({
    'git rev-parse -q --verify refs/tags/v3.1.0^{commit}': JSON_OUT('f'.repeat(40)),
  })
  assert.throws(
    () => upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: 'd'.repeat(40), upstreamRepo: 'u/r', spawnSyncImpl: conflict }),
    (error) => error.code === 'UPDATE_TAG_CONFLICT',
  )

  const mismatch = fakeSpawn({
    'git rev-parse -q --verify refs/tags/v3.1.0^{commit}': JSON_OUT('d'.repeat(40)),
    'git rev-parse HEAD': JSON_OUT('c'.repeat(40)),
    'git -c advice.detachedHead=false checkout --detach v3.1.0': { status: 0 },
  })
  assert.throws(
    () => upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: 'd'.repeat(40), upstreamRepo: 'u/r', spawnSyncImpl: mismatch }),
    (error) => error.code === 'UPDATE_CHECKOUT_MISMATCH',
  )
})