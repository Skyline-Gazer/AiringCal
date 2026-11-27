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

function applyPlanEdgeone(observed) {
  return observed?.applyPlans?.[0]?.edgeone ?? null
}

function runSetupPty({ answers, env = {}, timeoutMs = 120_000 }) {
  const workDir = mkdtempSync(join(tmpdir(), 'wizard-pty-'))
  const resultPath = join(workDir, 'observed.json')
  const child = spawn('script', ['-qec', 'stty rows 48 cols 160; pnpm run setup', '/dev/null'], {
    cwd: ROOT,
    env: {
      ...process.env,
      SHELL: '/bin/bash',
      TERM: 'xterm-256color',
      COLUMNS: '160',
      LINES: '48',
      AIRINGCAL_CLOUDFLARE_API_TOKEN: '',
      AIRINGCAL_BANGUMI_TOKEN: '',
      AIRINGCAL_INVENTORY_DIR: workDir,
      AIRINGCAL_WIZARD_TEST_HOOKS: 'scripts/fixtures/wizard-acceptance-hooks.mjs',
      AIRINGCAL_WIZARD_TEST_RESULT: resultPath,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  let cursor = 0
  let index = 0
  const seen = []
  const stripAnsi = (text) => text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
  const feed = () => {
    const clean = stripAnsi(output)
    while (index < answers.length) {
      const idx = clean.indexOf(answers[index].wait, cursor)
      if (idx === -1) break
      const step = answers[index]
      cursor = idx + step.wait.length
      seen.push(step.label)
      // Give the prompt renderer a tick to attach its key listener before
      // typing; clack swallows keypresses that arrive during the first frame.
      setTimeout(() => { try { child.stdin.write(step.answer) } catch { /* exited */ } }, 180)
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

const CF_TOKEN = ['cf','synthetic','token'].join('-')+'\r'
const BGM_TOKEN = ['bgm','synthetic','token'].join('-')+'\r'
const S3_KEY = 'AKIA_'+'SYNTHETIC'
const S3_SECRET = ['synthetic','secret'].join('-')

const BASE_ANSWERS = (environmentChoice) => [
  { wait: 'fresh deployment; two masked tokens', answer: '\r', label: 'menu: install' },
  { wait: '◆  Environment', answer: environmentChoice === '1' ? '\r' : '\u001b[B\r', label: `environment: ${environmentChoice}` },
  { wait: 'Paste your Cloudflare API Token', answer: 'cf-synthetic-token\r', label: 'cf token masked' },
  { wait: 'Paste your Bangumi Personal Access Token', answer: 'bgm-synthetic-token\r', label: 'bgm token masked' },
  { wait: 'Attach a Custom Domain to the Worker', answer: '\r', label: 'custom domain: no' },
  { wait: 'Confirm and Install', answer: '\r', label: 'review: confirm and install' },
  { wait: 'Install AiringCal in', answer: '\r', label: 'install: approved' },
]

test('CLI entrypoint: approved Production installation reaches the apply-mode executor (#205)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      ...BASE_ANSWERS('1'),
      { wait: 'Supply an independently scoped R2 credential', answer: '\r', label: 'fallback: accepted' },
      { wait: 'Cloudflare R2 S3 Access Key ID', answer: `${S3_KEY}\r`, label: 'fallback key masked' },
      { wait: 'Cloudflare R2 S3 Secret Access Key', answer: `${S3_SECRET}\r`, label: 'fallback secret masked' },
      { wait: 'Re-authorize and retry', answer: '\r', label: 'fallback: reauthorized' },
      { wait: 'Run the First Full Sync now', answer: '\r', label: 'first sync: requested' },
      { wait: 'Dispatch the Writer', answer: '\r', label: 'first sync: confirmed' },
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
    assert.equal(output.includes(CF_TOKEN.trim()), false, 'synthetic CF token never echoed')
    assert.equal(output.includes(BGM_TOKEN.trim()), false, 'synthetic PAT never echoed')
    assert.equal(output.includes(S3_KEY), false, 'fallback key never echoed')
  } finally { run.cleanup() }
})

test('CLI entrypoint: approved Development installation with deferred sync is AWAITING_FIRST_SYNC (#205)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      ...BASE_ANSWERS('2'),
      { wait: 'Run the First Full Sync now', answer: '\u001b[B\r', label: 'first sync: deferred' },
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
      { wait: 'Supply an independently scoped R2 credential', answer: '\u001b[B\r', label: 'fallback: declined' },
    ],
  })
  try {
    const code = await run.exitCode
    const output = run.output()
    assert.equal(code, 1, output.slice(-1200))
    assert.match(output, /DEPLOY_FAILED/)
    assert.match(output, /Planned Public URL — not yet deployed or verified/)
    assert.match(output, /Completed effects/)
  } finally { run.cleanup() }
})

test('CLI entrypoint: Validate API Credentials returns to interactive menu instead of exiting (#208 BUG-002 / UX-010)', SKIP ? { skip: SKIP } : {}, async () => {
  const run = runSetupPty({
    answers: [
      { wait: 'Validate API Credentials', answer: '\u001b[B\u001b[B\u001b[B\r', label: 'menu: validate' },
      { wait: 'Paste your Cloudflare API Token', answer: 'cf-synthetic-token\r', label: 'cf token masked' },
      { wait: 'Paste your Bangumi Personal Access Token', answer: 'bgm-synthetic-token\r', label: 'bgm token masked' },
      { wait: 'Next Action', answer: '\u001b[B\r', label: 'post-validate: view details' },
      { wait: 'Next Action', answer: '\u001b[B\u001b[B\u001b[B\r', label: 'post-validate: return to main menu' },
      { wait: 'AiringCal Setup', answer: '\u001b[B\u001b[B\u001b[B\u001b[B\u001b[B\r', label: 'menu: exit' },
    ],
  })
  try {
    const code = await run.exitCode
    const output = run.output()
    assert.equal(code, 0, output.slice(-1500))
    assert.match(output, /Validation Summary/)
    assert.match(output, /Detailed Validation Results/)
    assert.equal(run.seen.includes('menu: exit'), true, 'returned to main menu after validation before exiting')
    assert.equal(output.includes('cf-synthetic-token'), false)
    assert.equal(output.includes('bgm-synthetic-token'), false)
  } finally { run.cleanup() }
})
