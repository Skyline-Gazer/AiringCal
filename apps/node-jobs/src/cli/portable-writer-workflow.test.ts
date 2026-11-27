import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '.github', 'workflows', 'portable-writer.yml')

function jobSection(source: string, job: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${job}:`)
  assert.notEqual(start, -1, `workflow must define job ${job}`)
  const end = lines.findIndex((line, index) => index > start && /^  [a-z_-]+:$/.test(line))
  return lines.slice(start, end === -1 ? lines.length : end).join('\n')
}

test('workflow_dispatch target input supports production and development only (no staging)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  assert.match(source, /target:/)
  assert.match(source, /default: production/)
  assert.match(source, /type: choice/)
  assert.doesNotMatch(source, /- staging/)
  assert.doesNotMatch(source, /^  staging:/m)
  assert.match(source, /- production/)
  assert.match(source, /- development/)
})

test('development job routes dispatch at job level; writer gate is step-level environment-scoped (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const development = jobSection(source, 'development')
  const jobIf = development.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(jobIf, 'development job has a job-level if')
  assert.match(jobIf, /workflow_dispatch/)
  assert.match(jobIf, /inputs\.target == 'development'/)
  assert.doesNotMatch(jobIf, /schedule/)
  assert.doesNotMatch(jobIf, /AIRINGCAL_DEVELOPMENT_WRITER_ENABLED/)
  assert.match(development, /DEVELOPMENT_GATE: \$\{\{ vars\.AIRINGCAL_DEVELOPMENT_WRITER_ENABLED \}\}/)
  assert.match(development, /if \[ "\$\{DEVELOPMENT_GATE\}" != "true" \]; then/)
  assert.match(development, /- name: Development writer gate[\s\S]*?actions\/checkout/, 'gate precedes checkout')
  assert.equal(development.split('\n').some((line) => line.includes('environment: development')), true)
})

test('production job splits bootstrap dispatch gate from schedule writer gate (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const productionJob = jobSection(source, 'production')
  const productionIf = productionJob.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(productionIf, 'production job has a job-level if')
  assert.match(productionIf, /schedule/)
  assert.match(productionIf, /\(inputs\.target \|\| 'production'\) == 'production'/)
  assert.match(productionIf, /vars\.AIRINGCAL_WRITER_ENABLED == 'true'/)
  assert.doesNotMatch(productionIf, /AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED/)
  assert.match(
    productionJob,
    /\(github\.event_name == 'schedule' && vars\.AIRINGCAL_WRITER_ENABLED == 'true'\) \|\| \(github\.event_name == 'workflow_dispatch' && \(inputs\.target \|\| 'production'\) == 'production'\)/,
  )
  assert.match(productionJob, /- name: Production bootstrap gate \(fails closed\)/)
  assert.match(productionJob, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/)
  assert.match(productionJob, /BOOTSTRAP_GATE: \$\{\{ vars\.AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED \}\}/)
  assert.match(productionJob, /if \[ "\$\{BOOTSTRAP_GATE\}" != "true" \]; then/)
  assert.match(productionJob, /- name: Production bootstrap gate[\s\S]*?actions\/checkout/, 'bootstrap gate precedes checkout')
  assert.doesNotMatch(
    productionJob.split('- name: Production bootstrap gate')[1]!.split('- name:')[0]!,
    /echo [^\n]*BOOTSTRAP_GATE/,
    'gate must never echo the flag value',
  )
  assert.equal(productionJob.split('\n').some((line) => line.includes('environment: production')), true)
  assert.match(productionJob, /airingcal-production/)
  assert.doesNotMatch(productionJob, /airing-cal-checkpoint|airing-cal-public/)
  assert.match(productionJob, /vars\.AIRINGCAL_PRODUCTION_R2_BUCKET/)
  assert.doesNotMatch(productionJob, /AIRINGCAL_PRODUCTION_CHECKPOINT_R2_BUCKET|AIRINGCAL_PRODUCTION_PUBLIC_R2_BUCKET/)
  assert.match(productionJob, /checkpoint_bucket=\$bucket/)
  assert.match(productionJob, /public_bucket=\$bucket/)
})

test('job-level if expressions never reference secrets (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const jobIfs = source.split('\n').filter((line) => line.startsWith('    if:'))
  assert.equal(jobIfs.length, 2)
  for (const jobIf of jobIfs) {
    assert.doesNotMatch(jobIf, /secrets\./, `job-level if must not use secrets: ${jobIf}`)
  }
})

test('production job expands only production-prefixed secrets and vars (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const production = jobSection(source, 'production')
  const refs = [...production.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1]!)
  assert.ok(refs.length > 0, 'production job binds secrets/vars')
  for (const name of refs) {
    assert.match(
      name,
      /^(AIRINGCAL_PRODUCTION_|AIRINGCAL_WRITER_ENABLED$)/,
      `unexpected non-production reference: ${name}`,
    )
  }
})

test('development job expands only AIRINGCAL_DEVELOPMENT_-prefixed secrets and vars (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const development = jobSection(source, 'development')
  const refs = [...development.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1]!)
  assert.ok(refs.length > 0, 'development job binds secrets/vars')
  for (const name of refs) {
    assert.match(name, /^AIRINGCAL_DEVELOPMENT_/, `unexpected non-development reference: ${name}`)
  }
  assert.match(development, /vars\.AIRINGCAL_DEVELOPMENT_WRITER_ENABLED/, 'step-level gate references the environment-scoped var')
  assert.match(development, /vars\.AIRINGCAL_DEVELOPMENT_R2_BUCKET/)
})

test('every job gates/fails closed before checkout and validates config before the Builder (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  for (const job of ['development', 'production']) {
    const section = jobSection(source, job)
    const steps = section.split('\n').filter((line) => line.startsWith('      - name:'))
    assert.ok(steps.length > 0, `${job} has steps`)
    assert.match(steps[0]!, /gate \(fails closed\)/, `${job} first step must be the gate`)
    const gateBlock = section.split('      - name:')[1] ?? ''
    assert.match(gateBlock, /exit 1/, `${job} gate must exit 1 when not enabled`)
    assert.match(gateBlock, /!= "true"/, `${job} gate must compare against "true"`)
    const validationIndex = steps.findIndex((line) => /Validate required/.test(line))
    assert.notEqual(validationIndex, -1, `${job} validates required config`)
    const runStepIndex = steps.findIndex((line) => /Run portable writer/.test(line))
    assert.notEqual(runStepIndex, -1, `${job} runs the portable writer`)
    assert.ok(validationIndex > 0, `${job} validation happens after gate`)
    assert.ok(runStepIndex > validationIndex, `${job} validation happens before the writer`)
    const checkoutIndex = steps.findIndex((line) => /Checkout/.test(line))
    assert.ok(checkoutIndex > 0, `${job} does not checkout before gating/validation`)
  }
})

test('schedule contract is fixed at 0 20 * * * (04:00 Asia/Shanghai daily) and production-only (Fix B & C)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  assert.match(source, /schedule:\n\s*- cron: '0 20 \* \* \*'/)
  assert.doesNotMatch(source, /17 \*\/6 \* \* \*/)
  assert.match(source, /04:00 Asia\/Shanghai == 20:00 UTC/)
})

test('production job enforces approved release identity, verifies checked-out source SHA, and never falls back to github.sha (Fix A)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const production = jobSection(source, 'production')
  const development = jobSection(source, 'development')

  // 1. Validate required production config requires AIRINGCAL_PRODUCTION_RELEASE_SHA
  assert.match(production, /AIRINGCAL_PRODUCTION_RELEASE_SHA: \$\{\{ vars\.AIRINGCAL_PRODUCTION_RELEASE_SHA \}\}/)
  assert.match(production, /AIRINGCAL_PRODUCTION_RELEASE_REF: \$\{\{ vars\.AIRINGCAL_PRODUCTION_RELEASE_REF \}\}/)
  assert.match(production, /for var in[\s\S]*?AIRINGCAL_PRODUCTION_RELEASE_SHA/)
  assert.match(production, /AIRINGCAL_PRODUCTION_RELEASE_SHA must be an exact 40-character hexadecimal git commit SHA/)
  assert.match(production, /dev\|refs\/heads\/dev\|origin\/dev\|HEAD\|\*-dev\|refs\/pull\/\*/)

  // 2. Checkout uses pinned checkout_ref from config step, never unpinned default checkout
  assert.match(production, /- name: Checkout approved production release source[\s\S]*?ref: \$\{\{ steps\.config\.outputs\.checkout_ref \}\}/)
  assert.match(production, /fetch-depth: 0/)

  // 3. Verify checked-out production release source runs after checkout and before install/build/writer
  const steps = production.split('\n').filter((line) => line.startsWith('      - name:'))
  const checkoutIdx = steps.findIndex((line) => /Checkout approved production release source/.test(line))
  const verifyIdx = steps.findIndex((line) => /Verify checked-out production release source/.test(line))
  const installIdx = steps.findIndex((line) => /Install/.test(line))
  const buildIdx = steps.findIndex((line) => /Build portable bundle/.test(line))
  const runIdx = steps.findIndex((line) => /Run portable writer/.test(line))
  assert.ok(checkoutIdx > 0)
  assert.ok(verifyIdx > checkoutIdx, 'source verification must follow checkout')
  assert.ok(installIdx > verifyIdx, 'dependency install must follow source verification')
  assert.ok(buildIdx > installIdx, 'bundle build must follow dependency install')
  assert.ok(runIdx > buildIdx, 'writer run must follow bundle build')

  // 4. Writer receives verified_source_sha, never github.sha
  assert.match(production, /BANGUMI_GIT_COMMIT_SHA: \$\{\{ steps\.verify_source\.outputs\.verified_source_sha \}\}/)
  assert.doesNotMatch(production, /BANGUMI_GIT_COMMIT_SHA: \$\{\{ github\.sha \}\}/)

  // 5. Development job keeps github.sha for development testing
  assert.match(development, /BANGUMI_GIT_COMMIT_SHA: \$\{\{ github\.sha \}\}/)
})

test('production config and source verification shell logic enforces all 8 Fix A release integrity scenarios', async () => {
  const { spawnSync } = await import('node:child_process')
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const production = jobSection(source, 'production')
  const configRun = production
    .split('- name: Validate required production config')[1]!
    .split('- name: Checkout approved production release source')[0]!
    .split('        run: |\n')[1]!
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')
  const verifyRun = production
    .split('- name: Verify checked-out production release source (fails closed)')[1]!
    .split('- name: Setup pnpm')[0]!
    .split('        run: |\n')[1]!
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n')

  const approvedSha = '42f497cab180cd57eb1d2dc773d6b9979d9428bc'
  const devHeadSha = '7da982de379ea1425a10ff2f4745712d19f16c6d'
  const baseEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    AIRINGCAL_PRODUCTION_BANGUMI_TOKEN: 'bgm-tok',
    AIRINGCAL_PRODUCTION_USERS_JSON: '[{"id":1}]',
    AIRINGCAL_PRODUCTION_PRIMARY_USER_ID: '1',
    AIRINGCAL_PRODUCTION_S3_ACCESS_KEY_ID: 'ak',
    AIRINGCAL_PRODUCTION_S3_SECRET_ACCESS_KEY: 'sk',
    AIRINGCAL_PRODUCTION_PUBLIC_BASE_URL: 'https://airingcal-production.r7a.workers.dev',
    AIRINGCAL_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    AIRINGCAL_PRODUCTION_R2_BUCKET: 'airingcal-production',
  }

  function runConfigStep(extraEnv: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'prod-cfg-'))
    const outPath = join(dir, 'github_output')
    writeFileSync(outPath, '')
    try {
      const res = spawnSync('bash', ['-c', configRun], {
        encoding: 'utf8',
        env: { ...baseEnv, GITHUB_OUTPUT: outPath, ...extraEnv },
      })
      const output = readFileSync(outPath, 'utf8')
      return { status: res.status, stdout: res.stdout, stderr: res.stderr, output }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // Scenario 1: Approved release execution (valid 40-hex SHA + optional release tag ref)
  const validWithTag = runConfigStep({
    AIRINGCAL_PRODUCTION_RELEASE_SHA: approvedSha.toUpperCase(),
    AIRINGCAL_PRODUCTION_RELEASE_REF: 'v3.0.0',
  })
  assert.equal(validWithTag.status, 0)
  assert.match(validWithTag.output, new RegExp(`release_sha=${approvedSha}`))
  assert.match(validWithTag.output, /checkout_ref=v3\.0\.0/)

  // Scenario 2: Missing release identity -> fails closed before checkout
  const missingSha = runConfigStep({ AIRINGCAL_PRODUCTION_RELEASE_SHA: '' })
  assert.notEqual(missingSha.status, 0)
  assert.match(missingSha.stdout + missingSha.stderr, /Missing required production config: AIRINGCAL_PRODUCTION_RELEASE_SHA/)

  // Scenario 3: Invalid release identity (short/non-hex SHA or mutable dev ref) -> fails closed
  const malformedSha = runConfigStep({ AIRINGCAL_PRODUCTION_RELEASE_SHA: 'not-a-40-hex-sha' })
  assert.notEqual(malformedSha.status, 0)
  assert.match(malformedSha.stdout + malformedSha.stderr, /must be an exact 40-character hexadecimal git commit SHA/)

  for (const forbiddenRef of ['dev', 'refs/heads/dev', 'origin/dev', 'HEAD', 'feature-dev', 'refs/pull/214/head']) {
    const badRef = runConfigStep({
      AIRINGCAL_PRODUCTION_RELEASE_SHA: approvedSha,
      AIRINGCAL_PRODUCTION_RELEASE_REF: forbiddenRef,
    })
    assert.notEqual(badRef.status, 0, `must refuse forbidden ref ${forbiddenRef}`)
    assert.match(badRef.stdout + badRef.stderr, /refuses mutable development ref/)
  }

  // Scenario 4 & 5: Source verification in a real temporary git repo (matching release vs mismatched unpublished dev commit)
  const repoDir = mkdtempSync(join(tmpdir(), 'prod-verify-git-'))
  try {
    spawnSync('git', ['init', repoDir], { encoding: 'utf8' })
    spawnSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repoDir, 'config', 'user.name', 'Test'], { encoding: 'utf8' })
    writeFileSync(join(repoDir, 'release.txt'), 'v3.0.0\n')
    spawnSync('git', ['-C', repoDir, 'add', 'release.txt'], { encoding: 'utf8' })
    spawnSync('git', ['-C', repoDir, 'commit', '-m', 'release'], { encoding: 'utf8' })
    const releaseCommit = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    spawnSync('git', ['-C', repoDir, 'tag', 'v3.0.0', releaseCommit], { encoding: 'utf8' })

    writeFileSync(join(repoDir, 'release.txt'), 'unreleased dev work\n')
    spawnSync('git', ['-C', repoDir, 'commit', '-am', 'dev work'], { encoding: 'utf8' })
    const unpublishedDevCommit = spawnSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    assert.notEqual(releaseCommit, unpublishedDevCommit)

    // When checked out on unpublished dev commit, verify_source fails closed!
    const outMismatch = join(repoDir, 'out_mismatch')
    writeFileSync(outMismatch, '')
    const mismatchRes = spawnSync('bash', ['-c', verifyRun], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GITHUB_OUTPUT: outMismatch,
        EXPECTED_RELEASE_SHA: releaseCommit,
        EXPECTED_RELEASE_REF: 'v3.0.0',
        WORKFLOW_TRIGGER_SHA: unpublishedDevCommit,
      },
    })
    assert.notEqual(mismatchRes.status, 0, 'must fail closed when checked-out HEAD is an unpublished dev commit')
    assert.match(mismatchRes.stdout + mismatchRes.stderr, /does not match approved AIRINGCAL_PRODUCTION_RELEASE_SHA/)

    // When checked out on the approved release commit, verify_source passes even if workflow trigger SHA was devHeadSha!
    spawnSync('git', ['-C', repoDir, 'checkout', '--detach', releaseCommit], { encoding: 'utf8' })
    const outMatch = join(repoDir, 'out_match')
    writeFileSync(outMatch, '')
    const matchRes = spawnSync('bash', ['-c', verifyRun], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GITHUB_OUTPUT: outMatch,
        EXPECTED_RELEASE_SHA: releaseCommit,
        EXPECTED_RELEASE_REF: 'v3.0.0',
        WORKFLOW_TRIGGER_SHA: devHeadSha,
      },
    })
    assert.equal(matchRes.status, 0, `expected verify_source to pass: ${matchRes.stderr}`)
    assert.match(readFileSync(outMatch, 'utf8'), new RegExp(`verified_source_sha=${releaseCommit}`))

    // When tag points to a different commit than EXPECTED_RELEASE_SHA, verify_source fails closed!
    spawnSync('git', ['-C', repoDir, 'tag', '-f', 'v3.0.0-drifted', unpublishedDevCommit], { encoding: 'utf8' })
    const outDriftedTag = join(repoDir, 'out_drifted')
    writeFileSync(outDriftedTag, '')
    const driftedTagRes = spawnSync('bash', ['-c', verifyRun], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        GITHUB_OUTPUT: outDriftedTag,
        EXPECTED_RELEASE_SHA: releaseCommit,
        EXPECTED_RELEASE_REF: 'v3.0.0-drifted',
        WORKFLOW_TRIGGER_SHA: devHeadSha,
      },
    })
    assert.notEqual(driftedTagRes.status, 0)
    assert.match(driftedTagRes.stdout + driftedTagRes.stderr, /does not resolve to approved AIRINGCAL_PRODUCTION_RELEASE_SHA/)
  } finally {
    rmSync(repoDir, { recursive: true, force: true })
  }
})

test('documentation and repository tree stay aligned with schedule, gate separation, and artifact convergence (Fix B, Fix C, Amendment)', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const docPaths = ['README.md', 'README.zh-CN.md', 'docs/DEPLOYMENT.md', 'docs/DEPLOYMENT.zh-CN.md']
  for (const rel of docPaths) {
    const content = readFileSync(join(repoRoot, rel), 'utf8')
    assert.doesNotMatch(content, /17 \*\/6 \* \* \*/, `${rel} must not contain stale 6-hour cron`)
    assert.match(content, /0 20 \* \* \*/, `${rel} must document the 0 20 * * * daily cron`)
    assert.match(content, /AIRINGCAL_PRODUCTION_RELEASE_SHA/, `${rel} must document AIRINGCAL_PRODUCTION_RELEASE_SHA`)
  }
  const skillsLock = JSON.parse(readFileSync(join(repoRoot, 'skills-lock.json'), 'utf8'))
  assert.deepEqual(
    Object.keys(skillsLock.skills).sort(),
    ['cloudflare', 'ponytail', 'ponytail-audit', 'ponytail-review', 'workers-best-practices'],
  )
})
