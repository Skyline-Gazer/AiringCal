/**
 * Full-chain functional acceptance tests for Self-Service Update (#228 closure).
 *
 * Exercises the real call chain:
 *   main() -> installFlow() -> runUpdatePreflight() -> discoverUpdateState() ->
 *   planUpdate() -> upgradeWorkspace() -> re-exec -> discoverPartialState() ->
 *   reviewAndAuthorize() -> runProductionApply() -> deployCloudflareReader() ->
 *   materialize-v3-read-staging-config.mjs -> /api/version.
 */

import assert from 'node:assert/strict'
import { spawnSync as realSpawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createLiveDevelopmentApplyIo } from './deploy-env.mjs'
import { createControlledProviderSimulator } from './fixtures/controlled-provider-sim.mjs'
import { main as wizardMain } from './setup-wizard.mjs'
import { discoverUpdateState, upgradeWorkspace } from './update-plan.mjs'

function cleanTestEnv(extra = {}) {
  const { GITHUB_REPOSITORY: _ghRepo, ...rest } = process.env
  return { ...rest, ...extra }
}

function makeScriptedUi(answers = {}) {
  const notes = []
  const logs = []
  const confirms = [...(answers.confirms ?? [])]
  const selects = [...(answers.selects ?? [])]
  const passwords = [...(answers.passwords ?? [])]
  const texts = [...(answers.texts ?? [])]
  const promptsList = []

  const pop = (queue, kind, message) => {
    promptsList.push({ kind, message })
    if (queue.length === 0) throw new Error(`Unexpected ${kind} prompt: ${message}`)
    return queue.shift()
  }

  return {
    notes,
    logs,
    promptsList,
    intro() {},
    outro() {},
    link(label, url) { return url ? `${label}: ${url}` : String(label) },
    cancel(msg) { logs.push(`cancel:${msg}`) },
    note(body, title) { notes.push({ title, body: String(body) }) },
    spinner() { return { start() {}, stop() {} } },
    log: {
      info(m) { logs.push(`info:${m}`) },
      warn(m) { logs.push(`warn:${m}`) },
      error(m) { logs.push(`error:${m}`) },
      step(m) { logs.push(`step:${m}`) },
      success(m) { logs.push(`success:${m}`) },
    },
    confirm: async ({ message }) => pop(confirms, 'confirm', message),
    select: async ({ message }) => pop(selects, 'select', message),
    password: async ({ message }) => pop(passwords, 'password', message),
    text: async ({ message }) => pop(texts, 'text', message),
    prompts: {
      confirm: async (_io, message) => pop(confirms, 'confirm', message),
      select: async (_io, message) => pop(selects, 'select', message),
      text: async (_io, message) => pop(texts, 'text', message),
      password: async (_io, message) => pop(passwords, 'password', message),
      askConfirm: async (_io, message) => pop(confirms, 'askConfirm', message),
      askSelect: async (_io, message) => pop(selects, 'askSelect', message),
      askText: async (_io, message) => pop(texts, 'askText', message),
      askSecret: async (_io, message) => pop(passwords, 'askSecret', message),
    },
  }
}

function createTempReleaseRepo({ shallow = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'airingcal-lifecycle-'))
  const upstream = join(dir, 'upstream.git')
  const clone = join(dir, 'clone')
  const runGit = (args, cwd = dir) => {
    const res = realSpawnSync('git', args, { cwd, encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    return res.stdout.trim()
  }

  runGit(['init', '--bare', upstream])
  const work = join(dir, 'work')
  runGit(['clone', upstream, work])
  runGit(['config', 'user.email', 'test@example.com'], work)
  runGit(['config', 'user.name', 'Test'], work)

  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: 'airing-cal',
    version: '3.0.0',
    packageManager: 'pnpm@12.23.0',
    engines: { node: '>=24' },
  }, null, 2))
  runGit(['add', 'package.json'], work)
  runGit(['commit', '-m', 'v3.0.0'], work)
  runGit(['tag', 'v3.0.0'], work)
  const sha300 = runGit(['rev-parse', 'HEAD'], work)

  writeFileSync(join(work, 'package.json'), JSON.stringify({
    name: 'airing-cal',
    version: '3.1.0',
    packageManager: 'pnpm@12.23.0',
    engines: { node: '>=24' },
  }, null, 2))
  runGit(['add', 'package.json'], work)
  runGit(['commit', '-m', 'v3.1.0'], work)
  runGit(['tag', 'v3.1.0'], work)
  const sha310 = runGit(['rev-parse', 'HEAD'], work)

  runGit(['push', 'origin', 'HEAD:refs/heads/main', '--tags'], work)
  if (shallow) {
    runGit(['clone', '--depth', '1', '--branch', 'v3.0.0', `file://${upstream}`, clone])
  } else {
    runGit(['clone', `file://${upstream}`, clone])
    runGit(['checkout', sha300], clone)
  }
  runGit(['config', 'user.email', 'test@example.com'], clone)
  runGit(['config', 'user.name', 'Test'], clone)

  return { dir, upstream, clone, sha300, sha310, runGit }
}

function setupExistingProductionSim({
  gitSha,
  releaseTag,
  releaseSha,
  deployedBuildSha = null,
  deployedPackageVersion = '3.0.0',
  writerRef = 'v3.0.0',
  writerSha = null,
  repo = 'owner/AiringCal',
  forkParent = null,
  releases = null,
  tagRefs = {},
  compareStatus = null,
  ghEnvVarOverrides = {},
  ghEnvVarErrors = {},
  pnpmInstallExit = 0,
  staleVersionHeader = null,
} = {}) {
  const sim = createControlledProviderSimulator({
    gitSha,
    releaseTag,
    releaseSha,
  })
  const primaryId = '0123456789abcdef0123456789abcdef'
  sim.seedGithubEnv('production', {
    variables: {
      AIRINGCAL_PRODUCTION_R2_BUCKET: 'airingcal-production',
      AIRINGCAL_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: primaryId,
      AIRINGCAL_PRODUCTION_PRIMARY_USER_ID: '901234',
      AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL: 'https://airingcal-production.primary-sim.workers.dev',
      ...(writerRef !== null ? { AIRINGCAL_PRODUCTION_RELEASE_REF: writerRef } : {}),
      ...(writerSha !== null ? { AIRINGCAL_PRODUCTION_RELEASE_SHA: writerSha } : {}),
    },
    secrets: [
      'AIRINGCAL_PRODUCTION_BANGUMI_TOKEN',
      'AIRINGCAL_PRODUCTION_S3_ACCESS_KEY_ID',
      'AIRINGCAL_PRODUCTION_S3_SECRET_ACCESS_KEY',
    ],
  })
  sim.seedBucket(primaryId, 'airingcal-production', {
    r2DevEnabled: false,
    objects: {
      'public/current-release.json': JSON.stringify({ release_id: 'rel-1', artifact_ref: 'snapshots/v1/1-abc.json' }),
      'snapshots/v1/1-abc.json': '{}',
    },
  })
  sim.seedWorker(primaryId, 'airingcal-production', {
    r2Bindings: [{ name: 'AIRINGCAL_R2', bucketName: 'airingcal-production' }],
  })

  const liveReader = {
    package: deployedPackageVersion,
    commitSha: deployedBuildSha,
  }
  const sourceRepo = forkParent ?? repo
  const releaseList = releases ?? [
    { tag_name: releaseTag, draft: false, prerelease: false },
  ]
  const resolvedTags = {
    ...(writerRef && writerRef !== releaseTag ? { [writerRef]: writerSha ?? releaseSha } : {}),
    [releaseTag]: releaseSha,
    ...tagRefs,
  }

  const spawnSyncImpl = (cmd, args, options = {}) => {
    // Let real materialize-v3-read-staging-config.mjs execute!
    if (cmd === process.execPath && String(args[0] ?? '').endsWith('materialize-v3-read-staging-config.mjs')) {
      return realSpawnSync(cmd, args, options)
    }
    if (cmd === 'pnpm' && args[0] === '--version') {
      return { status: 0, stdout: '12.23.0\n', stderr: '' }
    }
    if (cmd === 'pnpm' && args[0] === 'install') {
      return { status: pnpmInstallExit, stdout: '', stderr: pnpmInstallExit === 0 ? '' : 'ERR_PNPM_INSTALL_FAILED' }
    }
    if (cmd === 'pnpm' && args[0] === 'exec' && args[1] === 'wrangler' && args[2] === 'deploy') {
      const cfgIdx = args.indexOf('--config')
      if (cfgIdx >= 0) {
        const toml = readFileSync(args[cfgIdx + 1], 'utf8')
        const shaMatch = toml.match(/BANGUMI_GIT_COMMIT_SHA\s*=\s*"([0-9a-f]{40})"/i)
        const pkgMatch = toml.match(/PACKAGE_VERSION\s*=\s*"([^"]+)"/)
        if (shaMatch) liveReader.commitSha = shaMatch[1].toLowerCase()
        if (pkgMatch) liveReader.package = pkgMatch[1]
      }
      return sim.spawnSyncImpl(cmd, args, options)
    }
    if (cmd === 'gh' && args[0] === 'api') {
      const path = String(args[1] ?? '')
      if (path === `repos/${repo}`) {
        return {
          status: 0,
          stdout: JSON.stringify(forkParent ? { fork: true, parent: { full_name: forkParent } } : { fork: false }),
          stderr: '',
        }
      }
      if (path.startsWith(`repos/${sourceRepo}/releases?`)) {
        return { status: 0, stdout: JSON.stringify(releaseList), stderr: '' }
      }
      if (path === `repos/${sourceRepo}/releases/latest`) {
        return { status: 0, stdout: `${releaseTag}\n`, stderr: '' }
      }
      const tagMatch = path.match(new RegExp(`^repos/${sourceRepo.replace('/', '\\/')}/git/ref/tags/(.+)$`))
      if (tagMatch) {
        const tag = decodeURIComponent(tagMatch[1])
        const sha = resolvedTags[tag]
        if (!sha) return { status: 1, stdout: '', stderr: 'HTTP 404 Not Found' }
        return { status: 0, stdout: JSON.stringify({ type: 'commit', sha }), stderr: '' }
      }
      if (path.includes('/contents/package.json?ref=')) {
        const pkg = { name: 'airing-cal', version: releaseTag.replace(/^v/, ''), packageManager: 'pnpm@12.23.0', engines: { node: '>=24' } }
        return { status: 0, stdout: Buffer.from(JSON.stringify(pkg)).toString('base64'), stderr: '' }
      }
      if (path.includes('/compare/') && compareStatus) {
        return { status: 0, stdout: JSON.stringify({ status: compareStatus }), stderr: '' }
      }
      const varMatch = path.match(/\/environments\/production\/variables\/([A-Z0-9_]+)$/)
      if (varMatch) {
        const key = varMatch[1]
        if (ghEnvVarErrors[key]) return ghEnvVarErrors[key]
        if (Object.hasOwn(ghEnvVarOverrides, key)) {
          const val = ghEnvVarOverrides[key]
          return val === null
            ? { status: 1, stdout: '', stderr: 'HTTP 404 Not Found' }
            : { status: 0, stdout: `${val}\n`, stderr: '' }
        }
      }
    }
    return sim.spawnSyncImpl(cmd, args, options)
  }

  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (target.startsWith('https://airingcal-production.primary-sim.workers.dev/api/version')) {
      return {
        status: 200,
        headers: new Map([['cache-control', staleVersionHeader ?? 'no-store']]),
        json: async () => ({
          app: 'airingcal',
          read: 'cloudflare',
          platform: 'cloudflare',
          package: liveReader.package,
          ...(liveReader.commitSha ? { build: { commitSha: liveReader.commitSha } } : {}),
        }),
      }
    }
    if (target === 'https://airingcal-production.primary-sim.workers.dev/public/current-release.json') {
      return {
        status: 200,
        json: async () => ({ release_id: 'rel-1', artifact_ref: 'snapshots/v1/1-abc.json' }),
      }
    }
    return sim.fetchImpl(url, init)
  }

  return { sim, primaryId, liveReader, spawnSyncImpl, fetchImpl }
}

test('Lifecycle 1-3: Legacy Reader migration -> BANGUMI_GIT_COMMIT_SHA injection -> NO_CHANGE on re-run', async () => {
  const invDir = mkdtempSync(join(tmpdir(), 'airingcal-inv-legacy-'))
  try {
    const sha = '42f497cab180cd57eb1d2dc773d6b9979d9428bc'
    const envSim = setupExistingProductionSim({
      gitSha: sha,
      releaseTag: 'v3.0.0',
      releaseSha: sha,
      deployedBuildSha: null, // Legacy Reader without build.commitSha
      writerRef: 'v3.0.0',
      writerSha: sha,
    })

    const spawnWrapped = (cmd, args, opts = {}) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 0, stdout: `${sha}\n`, stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'describe') return { status: 0, stdout: 'v3.0.0\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
        return { status: 0, stdout: 'false\n', stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return { status: 0, stdout: `${sha}\n`, stderr: '' }
      }
      return envSim.spawnSyncImpl(cmd, args, opts)
    }

    const ui1 = makeScriptedUi({
      confirms: [true, false, true], // redeploy legacy Reader, custom domain = No, final Update confirm
      passwords: ['cf-mgmt-sim-token', 'bgm-pat-sim-token'],
      selects: ['install'], // Confirm and Update
    })
    const res1 = await wizardMain(
      ['--operation', 'update', '--environment', 'production'],
      {
        env: cleanTestEnv({ AIRINGCAL_INVENTORY_DIR: invDir }),
        ui: ui1,
        spawnSyncImpl: spawnWrapped,
        fetchImpl: envSim.fetchImpl,
        hooks: {
          createApplyIo: ({ env, plan }) => createLiveDevelopmentApplyIo({
            env,
            plan,
            spawnSyncImpl: spawnWrapped,
            fetchImpl: envSim.fetchImpl,
            createObjectStore: envSim.sim.createObjectStore,
          }),
        },
        log: () => {},
      },
    )
    assert.equal(res1.ok, true, JSON.stringify(res1))
    assert.equal(res1.verdict, 'UPDATED_PARTIAL_VERIFICATION')
    assert.equal(envSim.liveReader.commitSha, sha, 'deployCloudflareReader injected BANGUMI_GIT_COMMIT_SHA')
    assert.ok(ui1.notes.some((n) => n.title === 'Legacy Reader Migration'))
    // Existing R2 data and S3 secrets preserved
    assert.equal(envSim.sim.getBucket(envSim.primaryId, 'airingcal-production').objects.has('snapshots/v1/1-abc.json'), true)

    // Re-run Update: now confirmed consistent -> NO_CHANGE without prompting for credentials
    const ui2 = makeScriptedUi({})
    const res2 = await wizardMain(
      ['--operation', 'update', '--environment', 'production'],
      {
        env: cleanTestEnv({ AIRINGCAL_INVENTORY_DIR: invDir }),
        ui: ui2,
        spawnSyncImpl: spawnWrapped,
        fetchImpl: envSim.fetchImpl,
        log: () => {},
      },
    )
    assert.equal(res2.ok, true)
    assert.equal(res2.verdict, 'NO_CHANGE')
    assert.equal(ui2.promptsList.length, 0)
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})

test('Lifecycle 4-6: Writer conflict, Writer API error (unknown), and Writer ahead block BEFORE upgrade', async () => {
  const sha300 = '1'.repeat(40)
  const sha310 = '2'.repeat(40)
  const sha320 = '3'.repeat(40)
  const makeLocalBehindSpawn = (envSim) => (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${sha300}\n`, stderr: '' }
    if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'describe') return { status: 0, stdout: 'v3.0.0\n', stderr: '' }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: 'false\n', stderr: '' }
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
    return envSim.spawnSyncImpl(cmd, args, opts)
  }

  // 1) Writer REF/SHA conflict
  const conflictSim = setupExistingProductionSim({
    gitSha: sha300,
    releaseTag: 'v3.1.0',
    releaseSha: sha310,
    writerRef: 'v3.1.0',
    writerSha: sha300, // conflicts with v3.1.0 -> sha310
  })
  const conflictRes = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: makeScriptedUi(),
    spawnSyncImpl: makeLocalBehindSpawn(conflictSim),
    fetchImpl: conflictSim.fetchImpl,
    log: () => {},
  })
  assert.equal(conflictRes.aborted, true, JSON.stringify(conflictRes))
  assert.equal(conflictRes.code, 'UPDATE_DEPLOYMENT_CONFLICT')

  // 2) Writer API 403 error -> unknown -> MUST abort, NEVER enter deployment review
  const apiErrSim = setupExistingProductionSim({
    gitSha: sha300,
    releaseTag: 'v3.1.0',
    releaseSha: sha310,
    ghEnvVarErrors: {
      AIRINGCAL_PRODUCTION_RELEASE_SHA: { status: 1, stdout: '', stderr: 'gh: HTTP 403 Forbidden' },
    },
  })
  const apiErrUi = makeScriptedUi()
  const apiErrRes = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: apiErrUi,
    spawnSyncImpl: makeLocalBehindSpawn(apiErrSim),
    fetchImpl: apiErrSim.fetchImpl,
    log: () => {},
  })
  assert.equal(apiErrRes.aborted, true)
  assert.equal(apiErrRes.code, 'UPDATE_WRITER_UNREADABLE')
  assert.equal(apiErrUi.promptsList.length, 0, 'must never prompt for credentials on unverified Writer')

  // 3) Writer SHA-only ahead of target -> blocked BEFORE workspace upgrade
  const aheadSim = setupExistingProductionSim({
    gitSha: sha300,
    releaseTag: 'v3.1.0',
    releaseSha: sha310,
    writerRef: null,
    writerSha: sha320,
    compareStatus: 'ahead',
  })
  const aheadRes = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: makeScriptedUi(),
    spawnSyncImpl: makeLocalBehindSpawn(aheadSim),
    fetchImpl: aheadSim.fetchImpl,
    log: () => {},
  })
  assert.equal(aheadRes.aborted, true)
  assert.equal(aheadRes.code, 'UPDATE_DEPLOYED_AHEAD')
})

test('Lifecycle 7-10: Real temp git repo upgrade, fork release source, shallow/dirty/diverged blocks, and cancel leaves zero mutations', async () => {
  const repo = createTempReleaseRepo()
  const shallowRepo = createTempReleaseRepo({ shallow: true })
  try {
    // Fork release source discovery on real temp repo
    const envSim = setupExistingProductionSim({
      gitSha: repo.sha300,
      releaseTag: 'v3.1.0',
      releaseSha: repo.sha310,
      repo: 'user-fork/AiringCal',
      forkParent: 'Skyline-Gazer/AiringCal',
      writerRef: 'v3.0.0',
      writerSha: repo.sha300,
    })
    const state = await discoverUpdateState({
      environment: 'production',
      env: cleanTestEnv(),
      cwd: repo.clone,
      spawnSyncImpl: (cmd, args, opts = {}) => {
        if (cmd === 'git') {
          if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/user-fork/AiringCal.git\n', stderr: '' }
          return realSpawnSync(cmd, args, { ...opts, cwd: repo.clone })
        }
        return envSim.spawnSyncImpl(cmd, args, opts)
      },
      fetchImpl: envSim.fetchImpl,
    })
    assert.equal(state.releaseSource.repository, 'Skyline-Gazer/AiringCal')
    assert.equal(state.plan.action, 'upgrade')

    // Shallow clone is blocked before any upgrade
    const shallowState = await discoverUpdateState({
      environment: 'production',
      env: cleanTestEnv(),
      cwd: shallowRepo.clone,
      spawnSyncImpl: (cmd, args, opts = {}) => {
        if (cmd === 'git') {
          if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/user-fork/AiringCal.git\n', stderr: '' }
          return realSpawnSync(cmd, args, { ...opts, cwd: shallowRepo.clone })
        }
        return envSim.spawnSyncImpl(cmd, args, opts)
      },
      fetchImpl: envSim.fetchImpl,
    })
    assert.equal(shallowState.plan.action, 'blocked')
    assert.equal(shallowState.plan.code, 'UPDATE_SHALLOW_CLONE')

    // Real upgradeWorkspace moves clone from sha300 to sha310 and returns exact rollback
    const up = upgradeWorkspace({
      targetTag: 'v3.1.0',
      targetSha: repo.sha310,
      remote: 'origin',
      cwd: repo.clone,
    })
    assert.equal(up.ok, true)
    assert.equal(up.headSha, repo.sha310)
    assert.match(up.rollback, /git switch --detach/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(shallowRepo.dir, { recursive: true, force: true })
  }
})

test('Lifecycle 11: User cancellation at upgrade prompt performs zero git fetch and zero remote mutations', async () => {
  const sha300 = '1'.repeat(40)
  const sha310 = '2'.repeat(40)
  const envSim = setupExistingProductionSim({
    gitSha: sha300,
    releaseTag: 'v3.1.0',
    releaseSha: sha310,
    writerRef: 'v3.0.0',
    writerSha: sha300,
  })
  const gitMutatingCalls = []
  const spawnWrapped = (cmd, args, opts = {}) => {
    if (cmd === 'git') {
      if (['fetch', 'switch', 'checkout'].includes(args[0])) gitMutatingCalls.push(args.join(' '))
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${sha300}\n`, stderr: '' }
      if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'describe') return { status: 0, stdout: 'v3.0.0\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: 'false\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 1, stdout: '', stderr: 'not found' }
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
    }
    return envSim.spawnSyncImpl(cmd, args, opts)
  }
  const ui = makeScriptedUi({ confirms: [false] })
  const res = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui,
    spawnSyncImpl: spawnWrapped,
    fetchImpl: envSim.fetchImpl,
    log: () => {},
  })
  assert.equal(res.ok, true)
  assert.equal(res.verdict, 'CANCELLED')
  assert.deepEqual(gitMutatingCalls, [], 'zero git fetch/switch calls before user confirmation')
})

test('Lifecycle 12: Dependency install failure surfaces local workspace rollback without touching remote state', async () => {
  const sha300 = '1'.repeat(40)
  const sha310 = '2'.repeat(40)
  const envSim = setupExistingProductionSim({
    gitSha: sha300,
    releaseTag: 'v3.1.0',
    releaseSha: sha310,
    writerRef: 'v3.0.0',
    writerSha: sha300,
    pnpmInstallExit: 1,
  })
  const logs = []
  let head = sha300
  const spawnWrapped = (cmd, args, opts = {}) => {
    if (cmd === 'git') {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${head}\n`, stderr: '' }
      if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'describe') return { status: 0, stdout: 'v3.0.0\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: 'false\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { status: 0, stdout: `${sha310}\n`, stderr: '' }
      if (args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'dev\n', stderr: '' }
      if (args[0] === 'merge-base') return { status: 0, stdout: '', stderr: '' }
      if (args[0] === 'switch') { head = sha310; return { status: 0, stdout: '', stderr: '' } }
    }
    return envSim.spawnSyncImpl(cmd, args, opts)
  }
  const res = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: makeScriptedUi({ confirms: [true] }),
    spawnSyncImpl: spawnWrapped,
    fetchImpl: envSim.fetchImpl,
    log: (m) => logs.push(m),
  })
  assert.equal(res.ok, false)
  assert.match(res.error, /no remote Cloudflare or GitHub changes were made/)
  assert.match(res.error, /git switch dev && pnpm install --frozen-lockfile/)
})

test('Lifecycle 13: Interactive Reader/Writer convergence & Install/Update/Recover operation mismatch', async () => {
  const invDir = mkdtempSync(join(tmpdir(), 'airingcal-inv-conv-'))
  try {
    const sha300 = '1'.repeat(40)
    const sha310 = '2'.repeat(40)
    const envSim = setupExistingProductionSim({
      gitSha: sha310,
      releaseTag: 'v3.1.0',
      releaseSha: sha310,
      deployedBuildSha: sha300,
      writerRef: 'v3.0.0',
      writerSha: sha300,
    })
    const spawnWrapped = (cmd, args, opts = {}) => {
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${sha310}\n`, stderr: '' }
      if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      if (cmd === 'git' && args[0] === 'describe') return { status: 0, stdout: 'v3.1.0\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: 'false\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        if (String(args[2] ?? '').startsWith('v3.0.0')) return { status: 0, stdout: `${sha300}\n`, stderr: '' }
        return { status: 0, stdout: `${sha310}\n`, stderr: '' }
      }
      return envSim.spawnSyncImpl(cmd, args, opts)
    }

    // 1) Interactive Update with authorized Writer release convergence (v3.0.0 -> v3.1.0)
    const uiConv = makeScriptedUi({
      confirms: [true, false, true, true], // redeploy confirm, custom domain = No, advance Writer target confirm, final Update confirm
      passwords: ['cf-mgmt-sim-token', 'bgm-pat-sim-token'],
      selects: ['install'],
    })
    const resConv = await wizardMain(['--operation', 'update', '--environment', 'production'], {
      env: cleanTestEnv({ AIRINGCAL_INVENTORY_DIR: invDir }),
      ui: uiConv,
      spawnSyncImpl: spawnWrapped,
      fetchImpl: envSim.fetchImpl,
      hooks: {
        createApplyIo: ({ env, plan }) => createLiveDevelopmentApplyIo({
          env,
          plan,
          spawnSyncImpl: spawnWrapped,
          fetchImpl: envSim.fetchImpl,
          createObjectStore: envSim.sim.createObjectStore,
        }),
      },
      log: () => {},
    })
    assert.equal(resConv.ok, true, JSON.stringify(resConv))
    assert.equal(resConv.verdict, 'UPDATED_PARTIAL_VERIFICATION')
    assert.equal(envSim.sim.getGithubEnv('production').variables.AIRINGCAL_PRODUCTION_RELEASE_SHA, sha310)
    assert.equal(envSim.sim.getGithubEnv('production').variables.AIRINGCAL_PRODUCTION_RELEASE_REF, 'v3.1.0')
    assert.equal(envSim.liveReader.commitSha, sha310)

    // 2) Choosing Install against existing installation is rejected with WIZARD_OPERATION_MISMATCH
    const uiMismatch = makeScriptedUi({
      confirms: [false], // custom domain = No
      passwords: ['cf-mgmt-sim-token', 'bgm-pat-sim-token'],
    })
    const resMismatch = await wizardMain(['--operation', 'install', '--environment', 'production'], {
      env: cleanTestEnv({ AIRINGCAL_INVENTORY_DIR: invDir }),
      ui: uiMismatch,
      spawnSyncImpl: spawnWrapped,
      fetchImpl: envSim.fetchImpl,
      log: () => {},
    })
    assert.equal(resMismatch.aborted, true)
    assert.equal(resMismatch.code, 'WIZARD_OPERATION_MISMATCH')
  } finally {
    rmSync(invDir, { recursive: true, force: true })
  }
})

test('Lifecycle 14: Stale /api/version cache-busting and verify states never return NO_CHANGE', async () => {
  const sha = '4'.repeat(40)
  const versionRequests = []
  const envSim = setupExistingProductionSim({
    gitSha: sha,
    releaseTag: 'v3.1.0',
    releaseSha: sha,
    deployedBuildSha: sha,
    writerRef: null,
    writerSha: null,
  })
  const wrappedFetch = async (url, init = {}) => {
    if (String(url).includes('/api/version')) {
      versionRequests.push({ url: String(url), cache: init.cache })
      return {
        status: 503,
        headers: new Map(),
        json: async () => ({}),
      }
    }
    return envSim.fetchImpl(url, init)
  }
  const spawnWrapped = (cmd, args, opts = {}) => {
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { status: 0, stdout: `${sha}\n`, stderr: '' }
    if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
    if (cmd === 'git' && args[0] === 'describe') return { status: 0, stdout: 'v3.1.0\n', stderr: '' }
    if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') return { status: 0, stdout: 'false\n', stderr: '' }
    if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: 'https://github.com/owner/AiringCal.git\n', stderr: '' }
    return envSim.spawnSyncImpl(cmd, args, opts)
  }

  // Writer identity missing -> interactive decline returns CANCELLED (never NO_CHANGE)
  const resMissing = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: makeScriptedUi({ confirms: [false] }),
    spawnSyncImpl: spawnWrapped,
    fetchImpl: wrappedFetch,
    log: () => {},
  })
  assert.equal(resMissing.verdict, 'CANCELLED')
  assert.equal(versionRequests.length, 1)
  assert.match(versionRequests[0].url, /\?_t=\d+/)
  assert.equal(versionRequests[0].cache, 'no-store')

  // Writer present + Reader unreachable -> interactive decline returns CANCELLED (never NO_CHANGE)
  const envSimUnreach = setupExistingProductionSim({
    gitSha: sha,
    releaseTag: 'v3.1.0',
    releaseSha: sha,
    writerRef: 'v3.1.0',
    writerSha: sha,
  })
  const resUnreach = await wizardMain(['--operation', 'update', '--environment', 'production'], {
    env: cleanTestEnv(),
    ui: makeScriptedUi({ confirms: [false] }),
    spawnSyncImpl: (cmd, args, opts = {}) => {
      if (cmd === 'git') return spawnWrapped(cmd, args, opts)
      return envSimUnreach.spawnSyncImpl(cmd, args, opts)
    },
    fetchImpl: wrappedFetch,
    log: () => {},
  })
  assert.equal(resUnreach.verdict, 'CANCELLED')
})
