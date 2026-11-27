import assert from 'node:assert/strict'
import test from 'node:test'

import {
  checkLocalTagConflict,
  compareVersions,
  discoverUpdateState,
  fetchReleaseTag,
  formatUpdateState,
  latestStableRelease,
  parseVersion,
  planUpdate,
  readGithubReleases,
  readPackageAt,
  readReaderVersion,
  readRemotePackageAt,
  readRemoteReleaseIdentity,
  satisfiesRange,
  toolchainBlockers,
  upgradeWorkspace,
} from './update-plan.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

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

test('satisfiesRange understands the engine syntax this repo writes', () => {
  assert.equal(satisfiesRange('24.22.3', '>=24'), true)
  assert.equal(satisfiesRange('22.20.0', '>=24'), false)
  assert.equal(satisfiesRange('24.22.3', '>=24.0.0 <25'), true, 'multi-clause ranges are evaluated clause by clause')
  assert.equal(satisfiesRange('25.0.0', '^24'), false)
  assert.equal(satisfiesRange('24.1.0', '~24.1'), true)
  assert.equal(satisfiesRange('24.2.0', '~24.1'), false)
  assert.equal(satisfiesRange('24.22.3', '*'), true)
  assert.equal(satisfiesRange('24.22.3', '>=twenty'), null, 'unparseable bounds must not invent a verdict')
})

test('toolchainBlockers blocks Node and pnpm major mismatch, but allows same-major pnpm', () => {
  const blocked = toolchainBlockers({
    pkg: { engines: { node: '>=26' }, packageManager: 'pnpm@12.23.0' },
    nodeVersion: '24.22.3',
    pnpmVersion: '9.15.9',
  })
  assert.deepEqual(blocked.map((entry) => entry.code), ['UPDATE_NODE_TOO_OLD', 'UPDATE_PNPM_MISMATCH'])
  assert.deepEqual(blocked.map((entry) => entry.severity), ['block', 'block'])
  assert.match(blocked[1].fix, /corepack prepare pnpm@12\.23\.0 --activate/)
  assert.deepEqual(
    toolchainBlockers({
      pkg: { engines: { node: '>=24' }, packageManager: 'pnpm@12.23.0' },
      nodeVersion: '24.22.3',
      pnpmVersion: '12.1.0',
    }),
    [],
  )
})

const atTarget = (overrides = {}) => ({
  local: { headSha: SHA_A, tag: 'v3.1.0', version: '3.1.0' },
  target: { tag: 'v3.1.0', sha: SHA_A },
  writer: { ref: 'v3.1.0', sha: SHA_A },
  reader: { reachable: true, version: '3.1.0', commitSha: SHA_A },
  dirty: false,
  statusOk: true,
  ...overrides,
})

test('planUpdate upgrades only when the commits differ and nothing would be lost', () => {
  const plan = planUpdate({
    local: { headSha: SHA_A, tag: 'v3.0.0', version: '3.0.0' },
    target: { tag: 'v3.1.0', sha: SHA_B },
  })
  assert.equal(plan.action, 'upgrade')
  assert.equal(plan.code, 'UPDATE_UPGRADE')

  assert.equal(
    planUpdate({
      local: { headSha: SHA_A, tag: 'v3.0.0', version: '3.0.0', dirty: true },
      target: { tag: 'v3.1.0', sha: SHA_B },
      dirty: true,
    }).code,
    'UPDATE_WORKSPACE_DIRTY',
  )
  assert.equal(
    planUpdate({ local: { headSha: SHA_A, dirty: true }, target: { tag: 'v3.1.0', sha: SHA_B }, statusOk: false }).code,
    'UPDATE_GIT_STATUS_UNKNOWN',
  )
  assert.equal(
    planUpdate({ local: { headSha: SHA_A, tag: 'v3.2.0' }, target: { tag: 'v3.1.0', sha: SHA_B } }).code,
    'UPDATE_LOCAL_AHEAD',
  )
})

test('planUpdate refuses to treat different commits as the same release', () => {
  const plan = planUpdate({
    local: { headSha: SHA_A, tag: 'v3.1.0', version: '3.1.0' },
    target: { tag: 'v3.1.0', sha: SHA_B },
  })
  assert.equal(plan.action, 'blocked')
  assert.equal(plan.code, 'UPDATE_UNTAGGED_DIVERGED')

  const untagged = planUpdate({
    local: { headSha: SHA_A, tag: null, version: null },
    target: { tag: 'v3.1.0', sha: SHA_B },
  })
  assert.equal(untagged.code, 'UPDATE_UNTAGGED_DIVERGED')
})

test('planUpdate separates current, verify and redeploy at the target commit', () => {
  assert.equal(planUpdate(atTarget()).action, 'current')
  assert.equal(planUpdate(atTarget({ local: { headSha: SHA_A, tag: 'v3.1.0', dirty: true }, dirty: true })).code, 'UPDATE_WORKSPACE_DIRTY')
  assert.equal(planUpdate(atTarget({ writer: null })).action, 'verify')
  assert.equal(planUpdate(atTarget({ reader: { reachable: false, version: null, reason: 'offline' } })).action, 'verify')
  assert.equal(planUpdate(atTarget({ writer: { ref: 'v3.0.0', sha: SHA_B } })).action, 'redeploy')
  assert.equal(
    planUpdate(atTarget({ writer: { ref: 'v3.1.0', sha: SHA_B } })).code,
    'UPDATE_DEPLOYMENT_CONFLICT',
  )
  assert.equal(planUpdate(atTarget({ writer: { ref: 'v3.2.0', sha: SHA_B } })).code, 'UPDATE_DEPLOYED_AHEAD')
  assert.equal(
    planUpdate(atTarget({ reader: { reachable: true, version: '3.1.0', commitSha: SHA_B } })).action,
    'redeploy',
  )
  // Legacy Reader without build.commitSha gets a safe migration redeploy path.
  const legacy = planUpdate(atTarget({ reader: { reachable: true, version: '3.1.0', commitSha: null } }))
  assert.equal(legacy.action, 'redeploy')
  assert.equal(legacy.code, 'UPDATE_READER_LEGACY_MIGRATION')

  // Malformed build.commitSha gets an explicit identity repair redeploy path.
  const invalidCommit = planUpdate(atTarget({ reader: { reachable: true, version: '3.1.0', commitSha: null, invalidCommitSha: true } }))
  assert.equal(invalidCommit.action, 'redeploy')
  assert.equal(invalidCommit.code, 'UPDATE_READER_IDENTITY_INVALID')

  // AIRINGCAL_*_RELEASE_SHA alone is a complete identity.
  assert.equal(planUpdate(atTarget({ writer: { sha: SHA_A } })).action, 'current')
  // A conflicting or unvalidated identity never becomes agreement.
  assert.equal(
    planUpdate(atTarget({ writer: { ref: 'v3.1.0', sha: SHA_B, conflict: true, reason: 'ref and sha disagree' } })).code,
    'UPDATE_DEPLOYMENT_CONFLICT',
  )
  const invalid = planUpdate(atTarget({ writer: { ref: 'v3.1.0', sha: null, invalid: true, reason: 'unresolvable ref' } }))
  assert.equal(invalid.action, 'unknown')
  assert.equal(invalid.code, 'UPDATE_DEPLOYMENT_UNVERIFIED')

  // Writer ahead / conflict / readError / shallow block BEFORE workspace upgrade (!atTarget).
  const behindLocal = { headSha: SHA_B, tag: 'v3.0.0', version: '3.0.0' }
  assert.equal(
    planUpdate({ local: behindLocal, target: { tag: 'v3.1.0', sha: SHA_A }, writer: { ref: 'v3.2.0', sha: SHA_B } }).code,
    'UPDATE_DEPLOYED_AHEAD',
  )
  assert.equal(
    planUpdate({ local: behindLocal, target: { tag: 'v3.1.0', sha: SHA_A }, writer: { sha: SHA_B, compareStatus: 'ahead' } }).code,
    'UPDATE_DEPLOYED_AHEAD',
  )
  assert.equal(
    planUpdate({ local: behindLocal, target: { tag: 'v3.1.0', sha: SHA_A }, writer: { readError: true, reason: 'HTTP 403' } }).code,
    'UPDATE_WRITER_UNREADABLE',
  )
  assert.equal(
    planUpdate({ local: { ...behindLocal, shallow: true }, target: { tag: 'v3.1.0', sha: SHA_A } }).code,
    'UPDATE_SHALLOW_CLONE',
  )
})

test('planUpdate leaves unreadable release identity unknown, never current', () => {
  const plan = planUpdate({ local: { headSha: SHA_A, tag: 'v3.1.0' }, target: null })
  assert.equal(plan.action, 'unknown')
  assert.equal(plan.code, 'UPDATE_TARGET_UNKNOWN')
})

test('planUpdate redeploys Development from the current commit and blocks a dirty tree', () => {
  const local = { headSha: SHA_A, tag: 'v3.1.0', version: '3.1.0', dirty: false }
  assert.equal(planUpdate({ environment: 'development', local }).action, 'redeploy')
  assert.equal(planUpdate({ environment: 'development', local: { ...local, dirty: true }, dirty: true }).code, 'UPDATE_WORKSPACE_DIRTY')
})

function fakeSpawn(routes) {
  const calls = []
  const impl = (cmd, args, options = {}) => {
    const key = `${cmd} ${args.join(' ')}`
    calls.push({ cmd, args: [...args], options })
    for (const [match, route] of routes) {
      if (key.includes(match)) {
        const result = typeof route === 'function' ? route({ cmd, args, options, key }) : route
        return { status: 0, stdout: '', stderr: '', ...result }
      }
    }
    return { status: 1, stdout: '', stderr: `unexpected command: ${key}` }
  }
  impl.calls = calls
  return impl
}

const out = (stdout) => ({ status: 0, stdout })

test('discoverUpdateState reads the fork parent, releases, environment and reader version', async () => {
  const spawnSyncImpl = fakeSpawn([
    ['git rev-parse HEAD', out(`${SHA_A}\n`)],
    ['git status --porcelain=v1', out('')],
    ['git describe --tags --exact-match', out('v3.0.0\n')],
    ['git remote get-url origin', out('https://github.com/me/AiringCal.git\n')],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_REF', out('v3.0.0')],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_SHA', out(SHA_A)],
    ['variables/AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL', out('https://cal.example.com')],
    ['repos/upstream/AiringCal/releases?per_page=100', out(JSON.stringify([
      { tag_name: 'v3.1.0', draft: false, prerelease: false },
      { tag_name: 'v3.0.0', draft: false, prerelease: false },
    ]))],
    ['repos/upstream/AiringCal/git/ref/tags/v3.1.0', out(JSON.stringify({ type: 'commit', sha: SHA_B }))],
    ['repos/upstream/AiringCal/git/ref/tags/v3.0.0', out(JSON.stringify({ type: 'commit', sha: SHA_A }))],
    ['gh api repos/me/AiringCal', out(JSON.stringify({ fork: true, parent: { full_name: 'upstream/AiringCal' } }))],
  ])
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    json: async () => ({ app: 'airingcal', read: 'cloudflare', package: '3.0.0', build: { commitSha: SHA_A } }),
  })
  const state = await discoverUpdateState({ environment: 'production', spawnSyncImpl, fetchImpl, cwd: process.cwd() })
  assert.equal(state.repository, 'me/AiringCal')
  assert.equal(state.releaseSource.repository, 'upstream/AiringCal')
  assert.equal(state.target.tag, 'v3.1.0')
  assert.equal(state.target.sha, SHA_B)
  assert.equal(state.writer.ref, 'v3.0.0')
  assert.equal(state.writer.sha, SHA_A)
  assert.equal(state.writer.configuredSha, SHA_A)
  assert.equal(state.reader.version, '3.0.0')
  assert.equal(state.reader.commitSha, SHA_A)
  assert.equal(state.releaseSourceUrl, 'https://github.com/upstream/AiringCal.git')
  assert.equal(state.plan.action, 'upgrade')
  const rendered = formatUpdateState(state)
  assert.match(rendered, /Target:\s+v3\.1\.0/)
  assert.match(rendered, /Action:\s+upgrade/)
})

test('discoverUpdateState validates the recorded Writer identity instead of trusting it', async () => {
  const routes = (shaValue, tags) => [
    ['git rev-parse HEAD', out(`${SHA_B}\n`)],
    ['git status --porcelain=v1', out('')],
    ['git describe --tags --exact-match', { status: 1, stderr: 'no tag' }],
    ['git remote get-url origin', out('https://github.com/me/AiringCal.git\n')],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_REF', out('v3.1.0')],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_SHA', out(shaValue)],
    ['repos/me/AiringCal/releases?per_page=100', out(JSON.stringify([{ tag_name: 'v3.1.0', draft: false, prerelease: false }]))],
    ['repos/me/AiringCal/git/ref/tags/v3.1.0', out(JSON.stringify({ type: 'commit', sha: tags }))],
    ['gh api repos/me/AiringCal', out(JSON.stringify({ full_name: 'me/AiringCal', fork: false, default_branch: 'dev' }))],
  ]
  const offline = async () => { throw new Error('offline') }

  const conflict = await discoverUpdateState({
    environment: 'production',
    spawnSyncImpl: fakeSpawn(routes(SHA_A, SHA_B)),
    fetchImpl: offline,
    cwd: process.cwd(),
  })
  assert.equal(conflict.writer.conflict, true)
  assert.equal(conflict.plan.code, 'UPDATE_DEPLOYMENT_CONFLICT')

  const malformed = await discoverUpdateState({
    environment: 'production',
    spawnSyncImpl: fakeSpawn(routes('not-a-sha', SHA_A)),
    fetchImpl: offline,
    cwd: process.cwd(),
  })
  assert.equal(malformed.writer.invalid, true)
  assert.equal(malformed.plan.action, 'unknown')
  assert.match(formatUpdateState(malformed), /unvalidated/)
})

test('discoverUpdateState keeps unreadable facts unreadable', async () => {
  const spawnSyncImpl = fakeSpawn([
    ['git rev-parse HEAD', out(`${SHA_A}\n`)],
    ['git status --porcelain=v1', out(' M docs/x.md\n')],
    ['git describe --tags --exact-match', { status: 1, stderr: 'no tag' }],
    ['git remote get-url origin', out('https://github.com/me/AiringCal.git\n')],
  ])
  const state = await discoverUpdateState({
    environment: 'production',
    spawnSyncImpl,
    fetchImpl: async () => { throw new Error('offline') },
    cwd: process.cwd(),
  })
  assert.equal(state.releaseError !== null, true)
  assert.equal(state.target, null)
  assert.equal(state.reader.reachable, false)
  assert.equal(state.plan.action, 'unknown')
  assert.equal(state.plan.code, 'UPDATE_TARGET_UNKNOWN')
  const rendered = formatUpdateState(state)
  assert.match(rendered, /uncommitted changes/)
  assert.match(rendered, /Reader:\s+unreachable/)
})

test('readGithubReleases distinguishes an unreadable list from an empty one', () => {
  assert.equal(readGithubReleases({ repository: 'u/r', spawnSyncImpl: () => ({ status: 1 }) }), null)
  assert.deepEqual(
    readGithubReleases({ repository: 'u/r', spawnSyncImpl: fakeSpawn([['releases?per_page=100', out('[]')]]) }),
    [],
  )
})

test('readRemoteReleaseIdentity resolves lightweight and annotated tags to a commit', () => {
  const lightweight = fakeSpawn([
    ['git/ref/tags/v3.1.0', out(JSON.stringify({ type: 'commit', sha: SHA_A }))],
  ])
  assert.deepEqual(
    readRemoteReleaseIdentity({ repository: 'u/r', tag: 'v3.1.0', spawnSyncImpl: lightweight }),
    { ok: true, sha: SHA_A, annotated: false },
  )

  const tagObject = 'c'.repeat(40)
  const annotated = fakeSpawn([
    ['git/ref/tags/v3.1.0', out(JSON.stringify({ type: 'tag', sha: tagObject }))],
    [`git/tags/${tagObject}`, out(JSON.stringify({ type: 'commit', sha: SHA_B }))],
  ])
  assert.deepEqual(
    readRemoteReleaseIdentity({ repository: 'u/r', tag: 'v3.1.0', spawnSyncImpl: annotated }),
    { ok: true, sha: SHA_B, annotated: true },
  )
})

test('readReaderVersion treats 0.0.0 and unreachable origins honestly', async () => {
  assert.deepEqual(await readReaderVersion({ baseUrl: '' }), {
    reachable: false,
    version: null,
    commitSha: null,
    invalidCommitSha: false,
    reason: 'No Reader origin is known (PUBLIC_BASE_URL is unset).',
  })
  const identified = await readReaderVersion({
    baseUrl: 'https://cal.example.com',
    fetchImpl: async () => ({ status: 200, json: async () => ({ package: '3.1.0', build: { commitSha: SHA_A.toUpperCase() } }) }),
  })
  assert.equal(identified.commitSha, SHA_A, 'the build commit is read and normalized')
  assert.equal(identified.invalidCommitSha, false)
  const unverified = await readReaderVersion({
    baseUrl: 'https://cal.example.com',
    fetchImpl: async () => ({ status: 200, json: async () => ({ package: '3.1.0', build: { commitSha: 'not-a-sha' } }) }),
  })
  assert.equal(unverified.commitSha, null, 'a malformed build commit is not an identity')
  assert.equal(unverified.invalidCommitSha, true)
  const placeholder = await readReaderVersion({
    baseUrl: 'https://cal.example.com/',
    fetchImpl: async () => ({ status: 200, json: async () => ({ package: '0.0.0' }) }),
  })
  assert.equal(placeholder.reachable, true)
  assert.equal(placeholder.version, null)
  const offline = await readReaderVersion({
    baseUrl: 'https://cal.example.com',
    fetchImpl: async () => { throw new Error('ENOTFOUND') },
  })
  assert.equal(offline.reachable, false)
})

test('readPackageAt and readRemotePackageAt read target commit metadata without local mutation', () => {
  const spawnSyncImpl = fakeSpawn([
    [`git show ${SHA_B}:package.json`, out(JSON.stringify({ version: '3.1.0', engines: { node: '>=24' } }))],
    [`contents/package.json?ref=${SHA_A}`, out(Buffer.from(JSON.stringify({ version: '3.2.0' }), 'utf8').toString('base64'))],
  ])
  assert.equal(readPackageAt({ sha: SHA_B, spawnSyncImpl }).version, '3.1.0')
  assert.equal(readPackageAt({ sha: 'nope', spawnSyncImpl }), null)
  assert.equal(readPackageAt({ sha: SHA_A, spawnSyncImpl }), null, 'unreadable package metadata stays null')
  assert.equal(readRemotePackageAt({ repository: 'u/r', sha: SHA_A, spawnSyncImpl }).version, '3.2.0')
})

test('discoverUpdateState distinguishes GitHub API 403/500 errors from 404 absent variables', async () => {
  const spawnSyncImpl = fakeSpawn([
    ['git rev-parse HEAD', out(`${SHA_A}\n`)],
    ['git status --porcelain=v1', out('')],
    ['git describe --tags --exact-match', out('v3.1.0\n')],
    ['git remote get-url origin', out('https://github.com/u/r.git\n')],
    ['releases?per_page=100', out(JSON.stringify([{ tag_name: 'v3.1.0', draft: false, prerelease: false }]))],
    ['git/ref/tags/v3.1.0', out(JSON.stringify({ type: 'commit', sha: SHA_A }))],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_REF', { status: 1, stderr: 'gh: HTTP 403 Forbidden' }],
    ['variables/AIRINGCAL_PRODUCTION_RELEASE_SHA', { status: 1, stderr: 'gh: HTTP 404 Not Found' }],
    ['api repos/u/r', out(JSON.stringify({ fork: false }))],
  ])
  const state = await discoverUpdateState({
    environment: 'production',
    spawnSyncImpl,
    fetchImpl: async () => { throw new Error('offline') },
    cwd: process.cwd(),
  })
  assert.equal(state.writer.readError, true)
  assert.equal(state.plan.action, 'unknown')
  assert.equal(state.plan.code, 'UPDATE_WRITER_UNREADABLE')
})

test('checkLocalTagConflict detects conflicting local tags read-only', () => {
  const spawnSyncImpl = fakeSpawn([
    ['rev-parse --verify refs/tags/v3.1.0^{commit}', out(`${SHA_A}\n`)],
  ])
  assert.equal(checkLocalTagConflict({ tag: 'v3.1.0', sha: SHA_B, spawnSyncImpl }).code, 'UPDATE_TAG_CONFLICT')
  assert.equal(checkLocalTagConflict({ tag: 'v3.1.0', sha: SHA_A, spawnSyncImpl }).conflict, false)
})

test('fetchReleaseTag never force-overwrites a conflicting local tag', () => {
  const already = fakeSpawn([['rev-parse --verify refs/tags/v3.1.0^{commit}', out(SHA_B)]])
  assert.deepEqual(fetchReleaseTag({ tag: 'v3.1.0', sha: SHA_B, spawnSyncImpl: already }), {
    ok: true,
    fetched: false,
    sha: SHA_B,
  })

  const conflict = fakeSpawn([['rev-parse --verify refs/tags/v3.1.0^{commit}', out(SHA_A)]])
  const refused = fetchReleaseTag({ tag: 'v3.1.0', sha: SHA_B, spawnSyncImpl: conflict })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'UPDATE_TAG_CONFLICT')
  assert.equal(conflict.calls.some((call) => call.args.includes('fetch')), false)
})

test('upgradeWorkspace switches to the verified commit and reports the previous head', () => {
  let headCalls = 0
  const spawnSyncImpl = fakeSpawn([
    ['git status --porcelain=v1', out('')],
    ['git rev-parse --is-shallow-repository', out('false\n')],
    ['rev-parse --verify refs/tags/v3.1.0^{commit}', (() => {
      let lookups = 0
      return () => {
        lookups += 1
        return lookups === 1 ? { status: 1, stdout: '' } : out(SHA_B)
      }
    })()],
    ['fetch --no-tags origin refs/tags/v3.1.0:refs/tags/v3.1.0', out('')],
    ['git symbolic-ref --short -q HEAD', out('dev\n')],
    ['git merge-base --is-ancestor', { status: 0, stdout: '' }],
    ['git switch --detach', out('')],
    ['git rev-parse HEAD', () => {
      headCalls += 1
      return out(`${headCalls === 1 ? SHA_A : SHA_B}\n`)
    }],
  ])
  const result = upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: SHA_B, spawnSyncImpl, log: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.previousHead, SHA_A)
  assert.equal(result.headSha, SHA_B)
  assert.equal(result.rollback, 'git switch dev', 'rollback returns to the branch, not just the commit')
  const switchCall = spawnSyncImpl.calls.find((call) => call.args[0] === 'switch')
  assert.deepEqual(switchCall.args, ['switch', '--detach', SHA_B])
})

test('upgradeWorkspace refuses a dirty tree and never trusts an unverified head', () => {
  const dirty = fakeSpawn([['git status --porcelain=v1', out(' M x\n')]])
  const refused = upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: SHA_B, spawnSyncImpl: dirty })
  assert.equal(refused.code, 'UPDATE_WORKSPACE_DIRTY')
  assert.equal(dirty.calls.some((call) => call.args[0] === 'switch'), false)

  const mismatch = fakeSpawn([
    ['git status --porcelain=v1', out('')],
    ['git rev-parse --is-shallow-repository', out('false\n')],
    ['rev-parse --verify refs/tags/v3.1.0^{commit}', out(SHA_B)],
    ['git merge-base --is-ancestor', { status: 0, stdout: '' }],
    ['git switch --detach', out('')],
    ['git rev-parse HEAD', out(`${SHA_A}\n`)],
  ])
  const result = upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: SHA_B, spawnSyncImpl: mismatch })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'UPDATE_CHECKOUT_MISMATCH')
})

test('upgradeWorkspace refuses to discard local commits and refuses shallow history', () => {
  const diverged = fakeSpawn([
    ['git status --porcelain=v1', out('')],
    ['git rev-parse --is-shallow-repository', out('false\n')],
    ['rev-parse --verify refs/tags/v3.1.0^{commit}', out(SHA_B)],
    ['git merge-base --is-ancestor', { status: 1, stdout: '' }],
  ])
  const refused = upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: SHA_B, spawnSyncImpl: diverged })
  assert.equal(refused.code, 'UPDATE_UNTAGGED_DIVERGED')
  assert.equal(diverged.calls.some((call) => call.args[0] === 'switch'), false, 'divergence must be refused before moving HEAD')

  const shallow = fakeSpawn([
    ['git status --porcelain=v1', out('')],
    ['git rev-parse --is-shallow-repository', out('true\n')],
  ])
  const shallowResult = upgradeWorkspace({ targetTag: 'v3.1.0', targetSha: SHA_B, spawnSyncImpl: shallow })
  assert.equal(shallowResult.code, 'UPDATE_SHALLOW_CLONE')
  assert.match(shallowResult.reason, /git fetch --unshallow/)
})