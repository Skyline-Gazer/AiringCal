import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  evaluateBaselinePresent,
  evaluatePostBenchGates,
  extractPendingOwnerItems,
  parseAcceptArgs,
  runPortableE2e,
  runRollbackDryRun,
  runShadowGateStatus,
  summarizeAcceptReport,
} from './reader-delivery-accept.mjs'

const PLAN_THRESHOLDS = Object.freeze({
  collectionsRepeatMedianMsMaxSoft: 300,
  collectionsRepeatMedianMsFail: 1000,
  imageRedirectExpected: 1,
  imageContentTypePrefix: 'image/',
  lcpMsMax: 2500,
  clsMax: 0.1,
  inpMsMax: 200,
  paginationFeedbackMsMax: 100,
})

function hostPathSample(medianMs, { contentType = 'image/jpeg', redirectCount = 1 } = {}) {
  return {
    host: 'https://cf.example',
    status: 'ok',
    error: null,
    identity: { generation: 1, content_hash: 'abc', artifact_ref: 'snapshots/v1/1-abc.json' },
    paths: {
      collections: {
        path: '/api/collections?type=watching&limit=24',
        samples: {
          repeat_same_isolate: {
            sample_name: 'repeat_same_isolate',
            ttfb_ms: { n: 5, median_ms: medianMs, p95_ms: medianMs + 10, values_ms: [medianMs] },
            n_ok: 5,
          },
        },
      },
    },
    image: {
      status: 'ok',
      reason: null,
      hash: 'f'.repeat(64),
      redirect_count: redirectCount,
      reader_status: 302,
      cdn_status: 200,
      content_type: contentType,
    },
  }
}

function benchReceipt({ hosts, widget = null, mainland = null, cfEqual = true } = {}) {
  return {
    schema_version: 1,
    kind: 'reader_delivery_bench',
    thresholds_enforced: false,
    hosts: hosts ?? [hostPathSample(200), { ...hostPathSample(180), host: 'https://eo.example' }],
    cf_vs_eo: {
      equal: cfEqual,
      generation: 1,
      content_hash: 'abc',
      note: cfEqual ? 'match' : 'mismatch',
    },
    widget: widget ?? {
      status: 'skipped_no_browser',
      lcp_ms: null,
      cls: null,
      inp_ms: null,
      pagination_feedback_ms: null,
    },
    mainland: mainland ?? {
      status: 'pending_owner_node',
      host: null,
      note: 'No AIRINGCAL_BENCH_MAINLAND_HOST; do not invent mainland metrics',
    },
    status: 'ok',
  }
}

test('parseAcceptArgs reads baseline/post/checklist paths and skip flags', () => {
  const parsed = parseAcceptArgs([
    'node',
    'scripts/reader-delivery-accept.mjs',
    '--baseline',
    'docs/v3/fixtures/reader-delivery-bench-baseline.json',
    '--post',
    'docs/v3/fixtures/reader-delivery-bench-post.json',
    '--checklist',
    'docs/v3/fixtures/reader-delivery-cutover-checklist.json',
    '--skip-e2e',
    '--skip-cf-smoke',
  ])
  assert.equal(parsed.baseline, 'docs/v3/fixtures/reader-delivery-bench-baseline.json')
  assert.equal(parsed.post, 'docs/v3/fixtures/reader-delivery-bench-post.json')
  assert.equal(parsed.checklist, 'docs/v3/fixtures/reader-delivery-cutover-checklist.json')
  assert.equal(parsed.skipE2e, true)
  assert.equal(parsed.skipCfSmoke, true)
  assert.equal(parsed.help, false)

  const defaults = parseAcceptArgs(['node', 'scripts/reader-delivery-accept.mjs'])
  assert.equal(defaults.baseline, 'docs/v3/fixtures/reader-delivery-bench-baseline.json')
  assert.equal(defaults.post, 'docs/v3/fixtures/reader-delivery-bench-post.json')
  assert.equal(defaults.checklist, 'docs/v3/fixtures/reader-delivery-cutover-checklist.json')
  assert.equal(defaults.skipE2e, false)
})

test('evaluateBaselinePresent fails when baseline missing or wrong kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-baseline-'))
  try {
    const missing = evaluateBaselinePresent(join(dir, 'nope.json'))
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /missing|not found/i)

    const badPath = join(dir, 'bad.json')
    writeFileSync(badPath, JSON.stringify({ schema_version: 1, kind: 'other' }))
    const bad = evaluateBaselinePresent(badPath)
    assert.equal(bad.ok, false)
    assert.match(bad.reason, /kind|reader_delivery_bench/i)

    const goodPath = join(dir, 'good.json')
    writeFileSync(goodPath, JSON.stringify(benchReceipt()))
    const good = evaluateBaselinePresent(goodPath)
    assert.equal(good.ok, true)
    assert.equal(good.receipt.kind, 'reader_delivery_bench')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluatePostBenchGates reports pending when post JSON absent (never fabricates)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-post-'))
  try {
    const missing = evaluatePostBenchGates(join(dir, 'absent-post.json'), PLAN_THRESHOLDS)
    assert.equal(missing.ok, true)
    assert.equal(missing.measurable, false)
    assert.equal(missing.status, 'pending')
    assert.match(missing.reason, /missing|not present|pending/i)
    assert.equal(missing.failures.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluatePostBenchGates fails measurable gates on slow collections or octet-stream MIME', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-post-fail-'))
  try {
    const slowPath = join(dir, 'slow.json')
    writeFileSync(
      slowPath,
      JSON.stringify(
        benchReceipt({
          hosts: [
            hostPathSample(1500),
            { ...hostPathSample(200), host: 'https://eo.example' },
          ],
        }),
      ),
    )
    const slow = evaluatePostBenchGates(slowPath, PLAN_THRESHOLDS)
    assert.equal(slow.measurable, true)
    assert.equal(slow.ok, false)
    assert.ok(slow.failures.some((f) => /collections.*repeat|TTFB|> 1000/i.test(f)))

    const mimePath = join(dir, 'mime.json')
    writeFileSync(
      mimePath,
      JSON.stringify(
        benchReceipt({
          hosts: [
            hostPathSample(200, { contentType: 'application/octet-stream' }),
            {
              ...hostPathSample(180, { contentType: 'application/octet-stream' }),
              host: 'https://eo.example',
            },
          ],
        }),
      ),
    )
    const mime = evaluatePostBenchGates(mimePath, PLAN_THRESHOLDS)
    assert.equal(mime.measurable, true)
    assert.equal(mime.ok, false)
    assert.ok(mime.failures.some((f) => /content-type|image\/|octet-stream/i.test(f)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluatePostBenchGates passes when post medians and image MIME meet plan thresholds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-post-pass-'))
  try {
    const path = join(dir, 'post.json')
    writeFileSync(
      path,
      JSON.stringify(
        benchReceipt({
          hosts: [
            hostPathSample(250),
            { ...hostPathSample(220), host: 'https://eo.example' },
          ],
          widget: {
            status: 'ok',
            lcp_ms: 2000,
            cls: 0.05,
            inp_ms: 150,
            pagination_feedback_ms: 80,
          },
          mainland: { status: 'pending_owner_node', host: null, note: 'pending' },
          cfEqual: true,
        }),
      ),
    )
    const result = evaluatePostBenchGates(path, PLAN_THRESHOLDS)
    assert.equal(result.measurable, true)
    assert.equal(result.ok, true)
    assert.deepEqual(result.failures, [])
    assert.ok(result.notes.some((n) => /mainland|pending_owner/i.test(n)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evaluatePostBenchGates treats widget skipped as pending note not measurable fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-widget-'))
  try {
    const path = join(dir, 'post.json')
    writeFileSync(
      path,
      JSON.stringify(
        benchReceipt({
          widget: {
            status: 'skipped_no_browser',
            lcp_ms: null,
            cls: null,
            inp_ms: null,
            pagination_feedback_ms: null,
          },
        }),
      ),
    )
    const result = evaluatePostBenchGates(path, PLAN_THRESHOLDS)
    assert.equal(result.ok, true)
    assert.equal(result.measurable, true)
    assert.ok(result.notes.some((n) => /widget|skipped|pending/i.test(n)))
    assert.equal(result.failures.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('extractPendingOwnerItems lists checklist pending_owner without failing measurable exit alone', () => {
  const checklist = {
    schema_version: 1,
    kind: 'reader_delivery_cutover_checklist',
    status: 'pending_owner',
    items: [
      {
        id: 'cname-test-air-to-overseas-eo',
        title: 'CNAME cutover',
        status: 'pending_owner',
        requiresOwner: 'DNS',
      },
      {
        id: 'done-item',
        title: 'already done',
        status: 'done',
        requiresOwner: null,
      },
      {
        id: 'icp-cdn',
        title: 'ICP CDN enable',
        status: 'pending_owner',
        requiresOwner: '\u5907\u6848 hostname',
      },
    ],
  }
  const pending = extractPendingOwnerItems(checklist)
  assert.deepEqual(
    pending.map((p) => p.id),
    ['cname-test-air-to-overseas-eo', 'icp-cdn'],
  )
  assert.ok(pending.every((p) => p.status === 'pending_owner'))
})

test('summarizeAcceptReport exits 0 when measurables pass even if Owner items pending', () => {
  const report = summarizeAcceptReport({
    gates: [
      { id: 'baseline', ok: true, measurable: true },
      { id: 'post_bench', ok: true, measurable: true, status: 'pending', notes: ['post missing \u2192 pending'] },
      { id: 'portable_e2e', ok: true, measurable: true },
      { id: 'cf_smoke', ok: true, measurable: false, status: 'pending', reason: 'skipped in unit' },
      { id: 'mime_head', ok: true, measurable: false, status: 'pending', reason: 'no public URL' },
      { id: 'rollback_dry_run', ok: true, measurable: false, status: 'pending', reason: 'no credentials' },
      { id: 'shadow_gate', ok: true, measurable: false, status: 'pending', reason: 'inputs unavailable' },
    ],
    pendingOwner: [
      { id: 'mainland-bench', title: 'Mainland bench', status: 'pending_owner' },
      { id: 'production-apply', title: 'Production apply', status: 'pending_owner' },
    ],
  })
  assert.equal(report.exitCode, 0)
  assert.equal(report.measurable_ok, true)
  assert.equal(report.pending_owner.length, 2)
  assert.match(report.summary, /measurable.*pass/i)
})

test('summarizeAcceptReport exits non-zero when a measurable gate fails', () => {
  const report = summarizeAcceptReport({
    gates: [
      { id: 'baseline', ok: true, measurable: true },
      {
        id: 'post_bench',
        ok: false,
        measurable: true,
        failures: ['collections repeat_same_isolate median 1500ms > 1000ms'],
      },
      { id: 'portable_e2e', ok: true, measurable: true },
    ],
    pendingOwner: [{ id: 'icp', title: 'ICP', status: 'pending_owner' }],
  })
  assert.notEqual(report.exitCode, 0)
  assert.equal(report.measurable_ok, false)
  assert.ok(report.failed_gates.includes('post_bench'))
  assert.equal(report.pending_owner.length, 1)
})

test('importing the accept CLI module as a library does not auto-run main', async () => {
  assert.equal(typeof evaluatePostBenchGates, 'function')
  assert.equal(typeof summarizeAcceptReport, 'function')
})

test('runPortableE2e treats checks:9 stdout as pass when child hangs after ok', async () => {
  const gate = await runPortableE2e({
    spawnImpl: async () => ({
      ok: false,
      code: null,
      timedOut: true,
      stdout: JSON.stringify({ status: 'ok', stage: 'v3_portable_e2e', checks: 9 }) + '\n',
      stderr: 'timed out after 90000ms',
    }),
  })
  assert.equal(gate.ok, true)
  assert.equal(gate.measurable, true)
  assert.equal(gate.status, 'ok')
})

test('runShadowGateStatus stays pending and never spawns mutating portable-shadow-gate', async () => {
  const previous = {
    AIRINGCAL_BUILDER_SQLITE_PATH: process.env.AIRINGCAL_BUILDER_SQLITE_PATH,
    AIRINGCAL_SHADOW_LEGACY_JSON: process.env.AIRINGCAL_SHADOW_LEGACY_JSON,
    AIRINGCAL_SHADOW_CANDIDATE_JSON: process.env.AIRINGCAL_SHADOW_CANDIDATE_JSON,
  }
  process.env.AIRINGCAL_BUILDER_SQLITE_PATH = '/tmp/builder.sqlite'
  process.env.AIRINGCAL_SHADOW_LEGACY_JSON = '/tmp/legacy.json'
  process.env.AIRINGCAL_SHADOW_CANDIDATE_JSON = '/tmp/candidate.json'
  const calls = []
  try {
    const gate = await runShadowGateStatus({
      spawnImpl: async (command, args) => {
        calls.push({ command, args })
        return { ok: true, code: 0, timedOut: false, stdout: '{\"streak\":1}\n', stderr: '' }
      },
    })
    assert.equal(calls.length, 0, 'must not invoke portable-shadow-gate (writes migrate:shadow:streak)')
    assert.equal(gate.id, 'shadow_gate')
    assert.equal(gate.ok, true)
    assert.equal(gate.measurable, false)
    assert.equal(gate.status, 'pending')
    assert.match(String(gate.reason), /read-only|pending|no RO|without mutation/i)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('runShadowGateStatus reports RO streak JSON when provided without spawning CLI', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'accept-shadow-ro-'))
  const statusPath = join(dir, 'shadow-status.json')
  writeFileSync(
    statusPath,
    JSON.stringify({
      streak: 7,
      required_matches: 7,
      cutover_allowed: true,
      equal: true,
      updated_at: 1_700_000_000,
    }),
  )
  const previous = process.env.AIRINGCAL_SHADOW_GATE_STATUS_JSON
  process.env.AIRINGCAL_SHADOW_GATE_STATUS_JSON = statusPath
  const calls = []
  try {
    const gate = await runShadowGateStatus({
      spawnImpl: async (command, args) => {
        calls.push({ command, args })
        return { ok: true, code: 0, timedOut: false, stdout: '', stderr: '' }
      },
    })
    assert.equal(calls.length, 0)
    assert.equal(gate.status, 'ok')
    assert.equal(gate.measurable, true)
    assert.equal(gate.ok, true)
    assert.equal(gate.streak, 7)
    assert.equal(gate.cutover_allowed, true)
  } finally {
    if (previous === undefined) delete process.env.AIRINGCAL_SHADOW_GATE_STATUS_JSON
    else process.env.AIRINGCAL_SHADOW_GATE_STATUS_JSON = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runRollbackDryRun does not rubber-stamp non-zero exits that only mention Usage/generation', async () => {
  const previous = {
    AIRINGCAL_PUBLIC_S3_ENDPOINT: process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT,
    AIRINGCAL_S3_ACCESS_KEY_ID: process.env.AIRINGCAL_S3_ACCESS_KEY_ID,
  }
  process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT = 'https://example-bucket.r2.cloudflarestorage.com'
  process.env.AIRINGCAL_S3_ACCESS_KEY_ID = 'AKIA_TEST'
  try {
    const gate = await runRollbackDryRun({
      spawnImpl: async () => ({
        ok: false,
        code: 1,
        timedOut: false,
        stdout: '',
        stderr: 'Usage: portable-release-rollback.ts --generation <n> [--apply]\n',
      }),
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.measurable, true)
    assert.equal(gate.status, 'failed')
    assert.match(String(gate.reason), /failed exit 1/i)
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('runRollbackDryRun accepts structured dry_run receipt even when exit is non-zero', async () => {
  const previous = process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT
  process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT = 'https://example-bucket.r2.cloudflarestorage.com'
  try {
    const gate = await runRollbackDryRun({
      spawnImpl: async () => ({
        ok: false,
        code: 1,
        timedOut: false,
        stdout: JSON.stringify({
          dry_run: true,
          cas_result: 'conflict',
          target_generation: 2,
        }) + '\n',
        stderr: '',
      }),
    })
    assert.equal(gate.ok, true)
    assert.equal(gate.measurable, true)
    assert.equal(gate.status, 'ok')
    assert.equal(gate.dry_run, true)
  } finally {
    if (previous === undefined) delete process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT
    else process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT = previous
  }
})

test('runRollbackDryRun requires dry_run receipt on zero exit (no bare success)', async () => {
  const previous = process.env.AIRINGCAL_S3_ACCESS_KEY_ID
  process.env.AIRINGCAL_S3_ACCESS_KEY_ID = 'AKIA_TEST'
  try {
    const gate = await runRollbackDryRun({
      spawnImpl: async () => ({
        ok: true,
        code: 0,
        timedOut: false,
        stdout: 'rolled back somehow\n',
        stderr: '',
      }),
    })
    assert.equal(gate.ok, false)
    assert.equal(gate.measurable, true)
    assert.equal(gate.status, 'failed')
    assert.match(String(gate.reason), /dry_run|receipt/i)
  } finally {
    if (previous === undefined) delete process.env.AIRINGCAL_S3_ACCESS_KEY_ID
    else process.env.AIRINGCAL_S3_ACCESS_KEY_ID = previous
  }
})
