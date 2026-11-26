import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT = resolve(import.meta.dirname, '..')
const HAS_SCRIPT = existsSync('/usr/bin/script') || existsSync('/bin/script')
const SKIP = !HAS_SCRIPT
  ? 'requires util-linux `script` for a real PTY'
  : null

function runSetupPty({ answers, env = {}, timeoutMs = 120_000 }) {
  const workDir = mkdtempSync(join(tmpdir(), 'wizard-pty-'))
  const resultPath = join(workDir, 'observed.json')
  const child = spawn('script', ['-qec', 'pnpm run setup', '/dev/null'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHELL: '/bin/bash',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: '',
      AIRINGCAL_BANGUMI_TOKEN: '',
      AIRINGCAL_WIZARD_TEST_HOOKS: 'scripts/fixtures/wizard-acceptance-hooks.mjs',
      AIRINGCAL_WIZARD_TEST_RESULT: resultPath,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let index = 0
  const seen = []
  const feed = () => {
    while (index < answers.length && output.includes(answers[index].wait)) {
      const step = answers[index]
      seen.push(step.label)
      child.stdin.write(step.answer)
      index += 1
    }
  }
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); feed() })
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); feed() })
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
  const exitCode = new Promise((resolvePromise) => child.on('close', resolvePromise))
  return {
    exitCode,
    output: () => output,
    seen,
    result: () => (existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null),
    cleanup: () => clearTimeout(timer),
  }
}

const BASE_ANSWERS = (environmentChoice) => [
  { wait: 'AiringCal setup', answer: '1\r', label: 'menu: install' },
  { wait: 'Environment', answer: `${environmentChoice}\r`, label: `environment: ${environmentChoice}` },
  { wait: 'Cloudflare API token', answer: 'cf-synthetic-token\r', label: 'cf token masked' },
  { wait: 'Bangumi personal access token', answer: 'bgm-synthetic-token\r', label: 'bgm token masked' },
  { wait: 'Attach a custom domain', answer: 'n\r', label: 'custom domain: no' },
  { wait: 'Apply this plan to', answer: 'y\r', label: 'plan: approved' },
]

test('CLI entrypoint: approved Production installation reaches the apply-mode executor (#205)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      ...BASE_ANSWERS('1'),
      { wait: 'Supply an independently scoped R2 credential', answer: 'y\r', label: 'fallback: accepted' },
      { wait: 'Cloudflare R2 S3 Access Key ID', answer: 'AKIA_SYNTHETIC\r', label: 'fallback key masked' },
      { wait: 'Cloudflare R2 S3 Secret Access Key', answer: 'synthetic-secret\r', label: 'fallback secret masked' },
      { wait: 'Run the first Full Sync now', answer: 'y\r', label: 'first sync: requested' },
      { wait: 'This dispatches the Writer', answer: 'y\r', label: 'first sync: confirmed' },
    ],
  })
  try {
    const code = await run.exitCode
    const observed = run.result()
    const output = run.output()
    assert.equal(code, 0, `expected exit 0\n${output.slice(-1500)}`)
    assert.match(output, /READY/)
    assert.ok(observed, 'adapter result was written')
    const applyPlan = observed.applyPlans[0]
    assert.equal(applyPlan.mode, 'apply', 'executor receives an apply-mode plan')
    assert.equal(applyPlan.env, 'production')
    assert.equal(applyPlan.bucket, 'airingcal-production')
    assert.equal(applyPlan.workerName, 'airingcal-production')
    assert.equal(applyPlan.target, 'cloudflare')
    assert.equal(observed.applyEnvs[0].applyAuthorized, 'yes')
    assert.equal(observed.applyEnvs[0].liveConfirm, 'yes')
    assert.ok(observed.calls.includes('ensure-bucket'))
    assert.ok(observed.calls.includes('deploy-cloudflare'))
    assert.ok(observed.calls.includes('first-sync'))
    assert.ok(observed.calls.includes('verifier'))
    assert.equal(observed.s3OverrideSeen, true, 'credential fallback retry carried the override')
    assert.ok(observed.provisionAttempts >= 1)
    assert.equal(output.includes('cf-synthetic-token'), false, 'synthetic CF token never echoed')
    assert.equal(output.includes('bgm-synthetic-token'), false, 'synthetic PAT never echoed')
    assert.equal(output.includes('AKIA_SYNTHETIC'), false, 'fallback key never echoed')
  } finally { run.cleanup() }
})

test('CLI entrypoint: approved Development installation with deferred sync is AWAITING_FIRST_SYNC (#205)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      ...BASE_ANSWERS('2'),
      { wait: 'Run the first Full Sync now', answer: 'n\r', label: 'first sync: deferred' },
    ],
  })
  try {
    const code = await run.exitCode
    const observed = run.result()
    assert.equal(code, 0, run.output().slice(-1200))
    assert.match(run.output(), /AWAITING_FIRST_SYNC/)
    const applyPlan = observed.applyPlans[0]
    assert.equal(applyPlan.mode, 'apply')
    assert.equal(applyPlan.env, 'development')
    assert.equal(applyPlan.workerName, 'airingcal-development')
    assert.equal(observed.applyEnvs[0].applyAuthorized, null, 'Development needs no production gates')
    assert.equal(observed.calls.includes('first-sync'), false)
  } finally { run.cleanup() }
})

test('CLI entrypoint: declined credential fallback reports DEPLOY_FAILED with partial receipts (#205)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      ...BASE_ANSWERS('1'),
      { wait: 'Supply an independently scoped R2 credential', answer: 'n\r', label: 'fallback: declined' },
    ],
  })
  try {
    const code = await run.exitCode
    const output = run.output()
    assert.equal(code, 1, output.slice(-1200))
    assert.match(output, /DEPLOY_FAILED/)
    assert.match(output, /Completed effects/)
  } finally { run.cleanup() }
})
