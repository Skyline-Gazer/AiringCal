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

test('development job runs only on explicit development target plus writer enable var (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const development = jobSection(source, 'development')
  const jobIf = development.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(jobIf, 'development job has a job-level if')
  assert.match(jobIf, /workflow_dispatch/)
  assert.match(jobIf, /inputs\.target == 'development'/)
  assert.match(jobIf, /vars\.AIRINGCAL_DEVELOPMENT_WRITER_ENABLED == 'true'/)
  assert.doesNotMatch(jobIf, /schedule/)
  assert.equal(development.split('\n').some((line) => line.includes('environment: development')), true)
})

test('production job is gated by schedule or explicit production target plus writer enable var (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  const production = jobSection(source, 'production')
  const jobIf = production.split('\n').find((line) => line.startsWith('    if:'))
  assert.ok(jobIf, 'production job has a job-level if')
  assert.match(jobIf, /schedule/)
  assert.match(jobIf, /inputs\.target == 'production'/)
  assert.match(jobIf, /vars\.AIRINGCAL_WRITER_ENABLED == 'true'/)
  assert.equal(production.split('\n').some((line) => line.includes('environment: production')), true)
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
  assert.match(development, /vars\.AIRINGCAL_DEVELOPMENT_WRITER_ENABLED == 'true'/)
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

test('first step of each job validates required config and exits before the Builder (C3)', () => {
  const source = readFileSync(WORKFLOW_PATH, 'utf8')
  for (const job of ['staging', 'development', 'production']) {
    const section = jobSection(source, job)
    const steps = section.split('\n').filter((line) => line.startsWith('      - name:'))
    assert.ok(steps.length > 0, `${job} has steps`)
    assert.match(steps[0]!, /Validate required/, `${job} first step must validate config`)
    const validationBlock = section.split('      - name:')[1] ?? ''
    assert.match(validationBlock, /exit 1/, `${job} validation must exit 1 on missing config`)
    const runStepIndex = steps.findIndex((line) => /Run portable writer/.test(line))
    assert.notEqual(runStepIndex, -1, `${job} runs the portable writer`)
    assert.ok(runStepIndex > 0, `${job} validation happens before the writer`)
  }
})
