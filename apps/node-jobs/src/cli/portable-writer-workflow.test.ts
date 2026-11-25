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

test('workflow_dispatch target input defaults to staging (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  assert.match(source, /target:/)
  assert.match(source, /default: staging/)
  assert.match(source, /type: choice/)
  assert.match(source, /- staging/)
  assert.match(source, /- development/)
  assert.match(source, /- production/)
})

test('staging job runs only on an explicit staging workflow_dispatch (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const staging = jobSection(source, 'staging')
  const jobIf = staging.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(jobIf, 'staging job has a job-level if')
  assert.match(jobIf, /workflow_dispatch/)
  assert.match(jobIf, /\(inputs\.target \|\| 'staging'\) == 'staging'/)
  assert.doesNotMatch(jobIf, /!= 'production'/)
  assert.doesNotMatch(jobIf, /inputs\.target == 'production'/)
  assert.doesNotMatch(jobIf, /schedule/)
  assert.equal(staging.split('\n').some((line) => line.includes('environment: staging')), true)
})

test('development job routes dispatch at job level; writer gate is step-level environment-scoped (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const development = jobSection(source, 'development')
  const jobIf = development.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(jobIf, 'development job has a job-level if')
  assert.match(jobIf, /workflow_dispatch/)
  assert.match(jobIf, /inputs\.target == 'development'/)
  assert.doesNotMatch(jobIf, /schedule/)
  // GitHub resolves `vars` in a job-level if at repository scope only; the
  // environment-scoped writer gate must live inside the job (first step).
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
  assert.match(productionIf, /inputs\.target == 'production'/)
  assert.match(productionIf, /vars\.AIRINGCAL_WRITER_ENABLED == 'true'/)
  // The environment-scoped bootstrap flag is invisible to a job-level if —
  // it must never be referenced there; the fails-closed gate is step #1.
  assert.doesNotMatch(productionIf, /AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED/)
  assert.match(
    productionJob,
    /\(github\.event_name == 'schedule' && vars\.AIRINGCAL_WRITER_ENABLED == 'true'\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.target == 'production'\)/,
  )
  assert.match(productionJob, /- name: Production bootstrap gate \(fails closed\)/)
  assert.match(productionJob, /if: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/)
  assert.match(productionJob, /BOOTSTRAP_GATE: \$\{\{ vars\.AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED \}\}/)
  assert.match(productionJob, /if \[ "\$\{BOOTSTRAP_GATE\}" != "true" \]; then/)
  assert.match(productionJob, /- name: Production bootstrap gate[\s\S]*?actions\/checkout/, 'bootstrap gate precedes checkout')
  assert.doesNotMatch(
    productionJob.split('- name: Production bootstrap gate')[1].split('- name:')[0],
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
  assert.ok(jobIfs.length >= 2)
  for (const jobIf of jobIfs) {
    assert.doesNotMatch(jobIf, /secrets\./, `job-level if must not use secrets: ${jobIf}`)
  }
})

test('staging job expands only AIRINGCAL_STAGING_-prefixed secrets and vars (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const staging = jobSection(source, 'staging')
  const refs = [...staging.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1])
  assert.ok(refs.length > 0, 'staging job binds secrets/vars')
  for (const name of refs) {
    assert.match(name, /^AIRINGCAL_STAGING_/, `unexpected non-staging reference: ${name}`)
  }
})

test('production job expands only production-prefixed secrets and vars (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const production = jobSection(source, 'production')
  const refs = [...production.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1])
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
  const refs = [...development.matchAll(/(?:secrets|vars)\.([A-Z0-9_]+)/g)].map((match) => match[1])
  assert.ok(refs.length > 0, 'development job binds secrets/vars')
  for (const name of refs) {
    assert.match(name, /^AIRINGCAL_DEVELOPMENT_/, `unexpected non-development reference: ${name}`)
  }
  assert.match(development, /vars\.AIRINGCAL_DEVELOPMENT_WRITER_ENABLED/, 'step-level gate references the environment-scoped var')
  assert.match(development, /vars\.AIRINGCAL_DEVELOPMENT_R2_BUCKET/)
})

test('unified AIRINGCAL_{ENV}_{SERVICE}_{KEY} naming: 3 core secrets, shared S3 creds, non-secrets in vars', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const staging = jobSection(source, 'staging')
  const stagingSecrets = new Set(
    [...staging.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]),
  )
  assert.deepEqual(
    stagingSecrets,
    new Set([
      'AIRINGCAL_STAGING_BANGUMI_TOKEN',
      'AIRINGCAL_STAGING_S3_ACCESS_KEY_ID',
      'AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY',
      'AIRINGCAL_STAGING_BARK_URL',
    ]),
  )
  assert.doesNotMatch(staging, /AIRINGCAL_STAGING_CHECKPOINT_S3_|AIRINGCAL_STAGING_PUBLIC_S3_|AIRINGCAL_STAGING_BGM_TOKEN/)
  assert.match(staging, /vars\.AIRINGCAL_STAGING_USERS_JSON/)
  assert.match(staging, /vars\.AIRINGCAL_STAGING_PRIMARY_USER_ID/)
  assert.match(staging, /vars\.AIRINGCAL_STAGING_CLOUDFLARE_ACCOUNT_ID/)
})

test('every job gates/fails closed before checkout and validates config before the Builder (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  for (const job of ['staging', 'development', 'production']) {
    const section = jobSection(source, job)
    const steps = section.split('\n').filter((line) => line.startsWith('      - name:'))
    assert.ok(steps.length > 0, `${job} has steps`)
    if (job === 'staging') {
      assert.match(steps[0]!, /Validate required/, `${job} first step must validate config`)
    } else {
      // Dispatch jobs start with the environment-scoped writer gate: job-level
      // `if` cannot see environment vars, so the authoritative check is step 1.
      assert.match(steps[0]!, /gate \(fails closed\)/, `${job} first step must be the gate`)
      const gateBlock = section.split('      - name:')[1] ?? ''
      assert.match(gateBlock, /exit 1/, `${job} gate must exit 1 when not enabled`)
      assert.match(gateBlock, /!= "true"/, `${job} gate must compare against "true"`)
    }
    const validationIndex = steps.findIndex((line) => /Validate required/.test(line))
    assert.notEqual(validationIndex, -1, `${job} validates required config`)
    const runStepIndex = steps.findIndex((line) => /Run portable writer/.test(line))
    assert.notEqual(runStepIndex, -1, `${job} runs the portable writer`)
    assert.ok(validationIndex > 0 || job === 'staging', `${job} validation happens before the writer`)
    assert.ok(runStepIndex > validationIndex, `${job} validation happens before the writer`)
    const checkoutIndex = steps.findIndex((line) => /Checkout/.test(line))
    assert.ok(checkoutIndex >= 0 && (job === 'staging' ? checkoutIndex > validationIndex : checkoutIndex > 0), `${job} does not checkout before gating/validation`)
  }
})
