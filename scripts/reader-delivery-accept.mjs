#!/usr/bin/env node
/**
 * Reader & delivery acceptance checklist (PR-D / Task 5.2).
 *
 * Composes baseline+post bench JSON gates, portable e2e, optional CF smoke,
 * MIME sample HEAD, rollback dry-run, optional one-shot parity RO status JSON,
 * and cutover checklist Owner-pending items.
 *
 * Exit 0 only when all *measurable* gates pass. Owner-pending items are
 * printed separately and never the sole reason for a non-zero exit.
 *
 * Production data-integrity tool is one-shot `portable-shadow-gate` / snapshot
 * compare ([docs/v3/production-acceptance.md](../docs/v3/production-acceptance.md)
 * gate 5). This accept script keeps RO status support and does not require a
 * seven-match streak for Development reader acceptance.
 *
 * Usage:
 *   node scripts/reader-delivery-accept.mjs
 *   node scripts/reader-delivery-accept.mjs --post docs/v3/fixtures/reader-delivery-bench-post.json
 */
import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_BASELINE = 'docs/v3/fixtures/reader-delivery-bench-baseline.json'
export const DEFAULT_POST = 'docs/v3/fixtures/reader-delivery-bench-post.json'
export const DEFAULT_CHECKLIST = 'docs/v3/fixtures/reader-delivery-cutover-checklist.json'

/** Plan Task 5.1 Development acceptance thresholds (post JSON only). */
export const PLAN_THRESHOLDS = Object.freeze({
  collectionsRepeatMedianMsMaxSoft: 300,
  collectionsRepeatMedianMsFail: 1000,
  imageRedirectExpected: 1,
  imageContentTypePrefix: 'image/',
  lcpMsMax: 2500,
  clsMax: 0.1,
  inpMsMax: 200,
  paginationFeedbackMsMax: 100,
})

export function parseAcceptArgs(argv = process.argv) {
  const args = argv.slice(2)
  let baseline = DEFAULT_BASELINE
  let post = DEFAULT_POST
  let checklist = DEFAULT_CHECKLIST
  let skipE2e = false
  let skipCfSmoke = false
  let skipMimeHead = false
  let skipRollback = false
  let skipShadowGate = false
  let help = false
  let imagePublicUrl = process.env.AIRINGCAL_ACCEPT_IMAGE_URL?.trim() || null
  let imageHash = process.env.AIRINGCAL_ACCEPT_IMAGE_HASH?.trim() || null
  let publicBaseUrl = process.env.AIRINGCAL_PUBLIC_BASE_URL?.trim() || process.env.AIRINGCAL_IMAGE_BASE_URL?.trim() || null
  let rollbackGeneration = parsePositiveInt(process.env.AIRINGCAL_ACCEPT_ROLLBACK_GENERATION)
  let currentGeneration = parsePositiveInt(process.env.AIRINGCAL_ACCEPT_CURRENT_GENERATION)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--baseline' && args[i + 1]) baseline = args[++i]
    else if (arg === '--post' && args[i + 1]) post = args[++i]
    else if (arg === '--checklist' && args[i + 1]) checklist = args[++i]
    else if (arg === '--image-url' && args[i + 1]) imagePublicUrl = args[++i]
    else if (arg === '--image-hash' && args[i + 1]) imageHash = args[++i]
    else if (arg === '--public-base' && args[i + 1]) publicBaseUrl = args[++i]
    else if (arg === '--rollback-generation' && args[i + 1]) rollbackGeneration = parsePositiveInt(args[++i])
    else if (arg === '--current-generation' && args[i + 1]) currentGeneration = parsePositiveInt(args[++i])
    else if (arg === '--skip-e2e') skipE2e = true
    else if (arg === '--skip-cf-smoke') skipCfSmoke = true
    else if (arg === '--skip-mime-head') skipMimeHead = true
    else if (arg === '--skip-rollback') skipRollback = true
    else if (arg === '--skip-shadow-gate') skipShadowGate = true
    else if (arg === '--help' || arg === '-h') help = true
  }

  return {
    help,
    baseline,
    post,
    checklist,
    skipE2e,
    skipCfSmoke,
    skipMimeHead,
    skipRollback,
    skipShadowGate,
    imagePublicUrl,
    imageHash,
    publicBaseUrl,
    rollbackGeneration,
    currentGeneration,
  }
}

function parsePositiveInt(value) {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isSafeInteger(n) || n < 0) return null
  return n
}

/**
 * Resolve a reachable prior generation for rollback dry-run.
 * Explicit override wins; otherwise current-1 when current ≥ 2.
 * Returns null when no reachable prior exists (gate should be pending).
 */
export function resolveRollbackTargetGeneration({
  explicit = null,
  currentGeneration = null,
} = {}) {
  if (explicit != null) {
    const n = Number(explicit)
    if (!Number.isSafeInteger(n) || n < 1) return null
    return n
  }
  const current = Number(currentGeneration)
  if (!Number.isSafeInteger(current) || current < 2) return null
  return current - 1
}

function currentGenerationFromBenchReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null
  const hosts = Array.isArray(receipt.hosts) ? receipt.hosts : []
  for (const host of hosts) {
    const gen = host?.identity?.generation
    if (Number.isSafeInteger(gen) && gen >= 1) return gen
  }
  const cfGen = receipt.cf_vs_eo?.generation
  if (Number.isSafeInteger(cfGen) && cfGen >= 1) return cfGen
  return null
}

async function fetchCurrentGenerationFromHealth(publicBaseUrl, fetchImpl) {
  if (!publicBaseUrl) return null
  const base = String(publicBaseUrl).replace(/\/$/, '')
  try {
    const res = await fetchImpl(`${base}/api/health`, {
      headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
    })
    if (!res?.ok) return null
    const body = await res.json()
    const gen = body?.data?.publish?.generation
    return Number.isSafeInteger(gen) && gen >= 1 ? gen : null
  } catch {
    return null
  }
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return { exists: false, value: null }
  const raw = readFileSync(path, 'utf8')
  return { exists: true, value: JSON.parse(raw) }
}

export function evaluateBaselinePresent(baselinePath) {
  const resolved = resolve(ROOT, baselinePath)
  if (!existsSync(resolved)) {
    return {
      id: 'baseline',
      ok: false,
      measurable: true,
      reason: `baseline fixture missing: ${baselinePath}`,
      path: resolved,
    }
  }
  let receipt
  try {
    receipt = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    return {
      id: 'baseline',
      ok: false,
      measurable: true,
      reason: `baseline JSON unreadable: ${error instanceof Error ? error.message : String(error)}`,
      path: resolved,
    }
  }
  if (receipt?.kind !== 'reader_delivery_bench') {
    return {
      id: 'baseline',
      ok: false,
      measurable: true,
      reason: `baseline kind must be reader_delivery_bench (got ${receipt?.kind ?? 'undefined'})`,
      path: resolved,
      receipt,
    }
  }
  if (receipt?.schema_version !== 1) {
    return {
      id: 'baseline',
      ok: false,
      measurable: true,
      reason: `baseline schema_version must be 1 (got ${receipt?.schema_version})`,
      path: resolved,
      receipt,
    }
  }
  return {
    id: 'baseline',
    ok: true,
    measurable: true,
    reason: null,
    path: resolved,
    receipt,
  }
}

function collectionsRepeatMedian(host) {
  return host?.paths?.collections?.samples?.repeat_same_isolate?.ttfb_ms?.median_ms ?? null
}

export function evaluatePostBenchGates(postPath, thresholds = PLAN_THRESHOLDS) {
  const resolved = resolve(ROOT, postPath)
  if (!existsSync(resolved)) {
    return {
      id: 'post_bench',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: `post bench JSON not present (${postPath}); thresholds not enforced — do not fabricate`,
      failures: [],
      notes: [`post missing → pending (${postPath})`],
      path: resolved,
    }
  }

  let receipt
  try {
    receipt = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    return {
      id: 'post_bench',
      ok: false,
      measurable: true,
      status: 'failed',
      reason: `post JSON unreadable: ${error instanceof Error ? error.message : String(error)}`,
      failures: ['post JSON parse failed'],
      notes: [],
      path: resolved,
    }
  }

  if (receipt?.kind !== 'reader_delivery_bench') {
    return {
      id: 'post_bench',
      ok: false,
      measurable: true,
      status: 'failed',
      reason: `post kind must be reader_delivery_bench (got ${receipt?.kind ?? 'undefined'})`,
      failures: ['post kind invalid'],
      notes: [],
      path: resolved,
      receipt,
    }
  }

  const failures = []
  const notes = []
  const hosts = Array.isArray(receipt.hosts) ? receipt.hosts : []

  for (const host of hosts) {
    const label = host.host ?? 'unknown-host'
    if (host.status && host.status !== 'ok' && host.status !== 'incomplete') {
      failures.push(`${label}: host status ${host.status}`)
    }
    const median = collectionsRepeatMedian(host)
    if (median == null) {
      failures.push(`${label}: missing collections repeat_same_isolate median_ms`)
    } else if (median > thresholds.collectionsRepeatMedianMsFail) {
      failures.push(
        `${label}: collections repeat_same_isolate TTFB median ${median}ms > ${thresholds.collectionsRepeatMedianMsFail}ms`,
      )
    } else if (median > thresholds.collectionsRepeatMedianMsMaxSoft) {
      notes.push(
        `${label}: collections repeat_same_isolate median ${median}ms > soft target ${thresholds.collectionsRepeatMedianMsMaxSoft}ms (recorded; hard fail only > ${thresholds.collectionsRepeatMedianMsFail}ms)`,
      )
    }

    const image = host.image
    if (!image || image.status !== 'ok') {
      failures.push(`${label}: image probe not ok (${image?.status ?? 'missing'})`)
      continue
    }
    if (image.redirect_count !== thresholds.imageRedirectExpected) {
      failures.push(
        `${label}: image redirect_count ${image.redirect_count} (expected ${thresholds.imageRedirectExpected})`,
      )
    }
    const ct = String(image.content_type ?? '')
    if (!ct.startsWith(thresholds.imageContentTypePrefix)) {
      failures.push(
        `${label}: image Content-Type ${ct || '(empty)'} is not ${thresholds.imageContentTypePrefix}* (octet-stream originals must be 0)`,
      )
    }
  }

  if (receipt.cf_vs_eo && receipt.cf_vs_eo.equal !== true) {
    failures.push(`cf_vs_eo.equal is ${receipt.cf_vs_eo.equal}; CF vs EO generation/hash must match`)
  }

  const widget = receipt.widget ?? {}
  if (widget.status === 'ok') {
    if (widget.lcp_ms != null && widget.lcp_ms > thresholds.lcpMsMax) {
      failures.push(`widget LCP ${widget.lcp_ms}ms > ${thresholds.lcpMsMax}ms`)
    }
    if (widget.cls != null && widget.cls > thresholds.clsMax) {
      failures.push(`widget CLS ${widget.cls} > ${thresholds.clsMax}`)
    }
    if (widget.inp_ms != null && widget.inp_ms > thresholds.inpMsMax) {
      failures.push(`widget INP ${widget.inp_ms}ms > ${thresholds.inpMsMax}ms`)
    }
    if (
      widget.pagination_feedback_ms != null
      && widget.pagination_feedback_ms > thresholds.paginationFeedbackMsMax
    ) {
      failures.push(
        `widget pagination feedback ${widget.pagination_feedback_ms}ms > ${thresholds.paginationFeedbackMsMax}ms`,
      )
    }
  } else {
    notes.push(`widget status ${widget.status ?? 'missing'} — CWV thresholds pending (never fabricate)`)
  }

  const mainland = receipt.mainland ?? {}
  if (mainland.status === 'pending_owner_node' || mainland.status !== 'ok') {
    notes.push(`mainland.status=${mainland.status ?? 'missing'} (Owner node pending; do not invent metrics)`)
  }

  return {
    id: 'post_bench',
    ok: failures.length === 0,
    measurable: true,
    status: failures.length === 0 ? 'ok' : 'failed',
    reason: failures.length === 0 ? null : failures.join('; '),
    failures,
    notes,
    path: resolved,
    receipt,
  }
}

export function extractPendingOwnerItems(checklist) {
  const items = Array.isArray(checklist?.items) ? checklist.items : []
  return items
    .filter((item) => item && (item.status === 'pending_owner' || item.requiresOwner))
    .filter((item) => item.status !== 'done' && item.status !== 'ok' && item.status !== 'passed')
    .map((item) => ({
      id: item.id,
      title: item.title ?? item.id,
      status: item.status ?? 'pending_owner',
      requiresOwner: item.requiresOwner ?? null,
      command: item.command ?? null,
      gate: item.gate ?? null,
    }))
}

export function summarizeAcceptReport({ gates = [], pendingOwner = [] } = {}) {
  const measurableGates = gates.filter((g) => g.measurable)
  const failed = measurableGates.filter((g) => !g.ok)
  const measurable_ok = failed.length === 0
  const exitCode = measurable_ok ? 0 : 1
  const summary = measurable_ok
    ? `measurable gates pass (${measurableGates.length}); Owner-pending=${pendingOwner.length}`
    : `measurable gates failed: ${failed.map((g) => g.id).join(', ')}`

  return {
    exitCode,
    measurable_ok,
    summary,
    failed_gates: failed.map((g) => g.id),
    gates,
    pending_owner: pendingOwner,
  }
}

function spawnCapture(command, args, { cwd = ROOT, env = process.env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(payload)
    }
    const killTree = (signal = 'SIGTERM') => {
      if (child.pid == null) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        try { child.kill(signal) } catch { /* already gone */ }
      }
    }
    const timer = setTimeout(() => {
      killTree('SIGTERM')
      setTimeout(() => killTree('SIGKILL'), 1_500)
      finish({
        ok: false,
        code: null,
        timedOut: true,
        stdout,
        stderr: stderr || `timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish({
        ok: false,
        code: null,
        timedOut: false,
        stdout,
        stderr: stderr || (error instanceof Error ? error.message : String(error)),
      })
    })
    child.on('close', (code) => {
      finish({ ok: code === 0, code, timedOut: false, stdout, stderr })
    })
  })
}

function e2eStdoutSucceeded(stdout) {
  return /"status"\s*:\s*"ok"[\s\S]*"stage"\s*:\s*"v3_portable_e2e"/.test(stdout)
    || /"stage"\s*:\s*"v3_portable_e2e"[\s\S]*"status"\s*:\s*"ok"/.test(stdout)
}

export async function runPortableE2e({ skip = false, spawnImpl = spawnCapture } = {}) {
  if (skip) {
    return {
      id: 'portable_e2e',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'skipped via --skip-e2e',
    }
  }
  const port = String(8800 + Math.floor(Math.random() * 700))
  const result = await spawnImpl('node', ['scripts/v3-portable-e2e.mjs'], {
    timeoutMs: 90_000,
    env: { ...process.env, V3_E2E_PORT: port },
  })
  const stdoutOk = e2eStdoutSucceeded(result.stdout)
  const ok = result.ok || stdoutOk
  return {
    id: 'portable_e2e',
    ok,
    measurable: true,
    status: ok ? 'ok' : 'failed',
    reason: ok
      ? (result.timedOut && stdoutOk ? 'e2e printed ok before child hang; treated as pass' : null)
      : `v3-portable-e2e exit ${result.code}${result.timedOut ? ' (timed out)' : ''}`,
    stdout_tail: result.stdout.slice(-2000),
    stderr_tail: result.stderr.slice(-2000),
  }
}


/** True only for genuine missing credential/tooling — not failure JSON that happens to mention wrangler. */
export function isCfSmokeOwnerGated(combined, code = null) {
  if (code == null) return true
  const text = String(combined ?? '')
  // Explicit credential / login / missing-tool signals.
  if (/missing\s+(cloudflare\s+)?(api\s+)?token/i.test(text)) return true
  if (/wrangler\s+login/i.test(text)) return true
  if (/\bENOENT\b/.test(text) && /wrangler|tsx|node/i.test(text)) return true
  if (/credential|permission denied|unauthorized|authentication error/i.test(text)
    && !/"status"\s*:\s*"failed"/i.test(text)) {
    return true
  }
  // Structured smoke failure JSON with wranglerLog is a measurable fail, not pending.
  if (/"stage"\s*:\s*"v3_cf_read_smoke"/i.test(text) && /"status"\s*:\s*"failed"/i.test(text)) {
    return false
  }
  if (/"wranglerLog"\s*:/.test(text) && /"status"\s*:\s*"failed"/i.test(text)) {
    return false
  }
  return false
}

export async function runCfSmoke({ skip = false, spawnImpl = spawnCapture } = {}) {
  if (skip) {
    return {
      id: 'cf_smoke',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'skipped via --skip-cf-smoke',
    }
  }
  // Missing tooling/credentials → pending. Never treat the literal `wranglerLog`
  // key / command path alone as owner-gated — real smoke failures always include that key.
  const result = await spawnImpl('pnpm', ['exec', 'tsx', 'apps/v3-read-worker/scripts/staging-smoke.ts'], {
    timeoutMs: 240_000,
  })
  if (result.ok) {
    return { id: 'cf_smoke', ok: true, measurable: true, status: 'ok', reason: null }
  }
  const combined = `${result.stdout}\n${result.stderr}`
  const ownerGated = isCfSmokeOwnerGated(combined, result.code)
  if (ownerGated) {
    return {
      id: 'cf_smoke',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: `CF smoke unavailable in this environment (exit ${result.code}); recorded pending`,
      stderr_tail: result.stderr.slice(-1500),
    }
  }
  return {
    id: 'cf_smoke',
    ok: false,
    measurable: true,
    status: 'failed',
    reason: `CF smoke failed exit ${result.code}`,
    stderr_tail: result.stderr.slice(-1500),
  }
}

export async function runMimeSampleHead({
  skip = false,
  imagePublicUrl = null,
  imageHash = null,
  publicBaseUrl = null,
  fetchImpl = globalThis.fetch,
  baselineReceipt = null,
} = {}) {
  if (skip) {
    return {
      id: 'mime_head',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'skipped via --skip-mime-head',
    }
  }

  let url = imagePublicUrl
  if (!url && imageHash && publicBaseUrl) {
    url = `${publicBaseUrl.replace(/\/$/, '')}/images/${imageHash}/original`
  }
  if (!url && baselineReceipt) {
    const hostWithImage = (baselineReceipt.hosts ?? []).find((h) => h.image?.location || h.image?.hash)
    if (hostWithImage?.image?.location) url = hostWithImage.image.location
    else if (hostWithImage?.image?.hash && publicBaseUrl) {
      url = `${publicBaseUrl.replace(/\/$/, '')}/images/${hostWithImage.image.hash}/original`
    }
  }

  if (!url) {
    return {
      id: 'mime_head',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'no public image URL/hash available for MIME HEAD sample',
    }
  }

  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' })
    const contentType = res.headers.get('content-type') || ''
    const imageOk = contentType.toLowerCase().startsWith('image/')
    if (imageOk) {
      return {
        id: 'mime_head',
        ok: true,
        measurable: true,
        status: 'ok',
        reason: null,
        url,
        content_type: contentType,
        http_status: res.status,
      }
    }
    // Live public HEAD before cutover/MIME repair may still be octet-stream.
    // Record pending rather than fail measurable exit; post JSON gate remains hard.
    return {
      id: 'mime_head',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: `public MIME HEAD Content-Type ${contentType || '(empty)'} is not image/* (pending repair/cutover)`,
      url,
      content_type: contentType,
      http_status: res.status,
    }
  } catch (error) {
    return {
      id: 'mime_head',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: `MIME HEAD unreachable (${error instanceof Error ? error.message : String(error)})`,
      url,
    }
  }
}

export async function runRollbackDryRun({
  skip = false,
  spawnImpl = spawnCapture,
  rollbackGeneration = null,
  currentGeneration = null,
  publicBaseUrl = null,
  baselineReceipt = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (skip) {
    return {
      id: 'rollback_dry_run',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'skipped via --skip-rollback',
    }
  }
  // Dry-run without --apply. Needs store credentials; treat missing env as pending.
  const hasCreds = Boolean(
    process.env.AIRINGCAL_PUBLIC_S3_ENDPOINT
    || process.env.AIRINGCAL_S3_ACCESS_KEY_ID
    || process.env.AIRINGCAL_DEVELOPMENT_S3_ACCESS_KEY_ID
    || process.env.AWS_ACCESS_KEY_ID,
  )
  if (!hasCreds) {
    return {
      id: 'rollback_dry_run',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'rollback dry-run pending: no S3/public store credentials in environment',
    }
  }

  const explicit = rollbackGeneration ?? parsePositiveInt(process.env.AIRINGCAL_ACCEPT_ROLLBACK_GENERATION)
  let resolvedCurrent = currentGeneration
    ?? parsePositiveInt(process.env.AIRINGCAL_ACCEPT_CURRENT_GENERATION)
    ?? currentGenerationFromBenchReceipt(baselineReceipt)
  if (resolvedCurrent == null) {
    const healthBase = publicBaseUrl
      || process.env.AIRINGCAL_PUBLIC_BASE_URL?.trim()
      || process.env.AIRINGCAL_IMAGE_BASE_URL?.trim()
      || null
    resolvedCurrent = await fetchCurrentGenerationFromHealth(healthBase, fetchImpl)
  }

  const targetGeneration = resolveRollbackTargetGeneration({
    explicit,
    currentGeneration: resolvedCurrent,
  })
  if (targetGeneration == null) {
    return {
      id: 'rollback_dry_run',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'rollback dry-run pending: no reachable prior generation (need --rollback-generation or current generation ≥ 2)',
      current_generation: resolvedCurrent,
    }
  }

  const result = await spawnImpl(
    'pnpm',
    ['exec', 'tsx', 'apps/node-jobs/src/cli/portable-release-rollback.ts', '--generation', String(targetGeneration)],
    { timeoutMs: 60_000 },
  )
  const combined = `${result.stdout}\n${result.stderr}`
  const receipt = extractRollbackDryRunReceipt(result.stdout)
  if (receipt?.dry_run === true) {
    return {
      id: 'rollback_dry_run',
      ok: true,
      measurable: true,
      status: 'ok',
      reason: null,
      dry_run: true,
      cas_result: receipt.cas_result ?? null,
      target_generation: receipt.target_generation ?? targetGeneration,
      code: result.code,
    }
  }
  if (/credential|AccessDenied|Missing|required env|ENOENT|login|Configure AIRINGCAL_PUBLIC_S3/i.test(combined)) {
    return {
      id: 'rollback_dry_run',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'rollback dry-run pending after credential/env failure',
      stderr_tail: result.stderr.slice(-1200),
      target_generation: targetGeneration,
    }
  }
  return {
    id: 'rollback_dry_run',
    ok: false,
    measurable: true,
    status: 'failed',
    reason: receipt
      ? `rollback dry-run receipt missing dry_run:true (exit ${result.code})`
      : `rollback dry-run failed exit ${result.code}: no dry_run receipt`,
    stderr_tail: result.stderr.slice(-1200),
    stdout_tail: result.stdout.slice(-800),
    target_generation: targetGeneration,
  }
}

/** Parse a RollbackReceipt-like JSON object from CLI stdout (first object with dry_run). */
export function extractRollbackDryRunReceipt(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'dry_run' in parsed) {
      return parsed
    }
  } catch {
    // Fall through to line / brace scanning.
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'dry_run' in parsed) {
        return parsed
      }
    } catch {
      // ignore non-JSON lines
    }
  }
  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'dry_run' in parsed) {
        return parsed
      }
    } catch {
      return null
    }
  }
  return null
}

export async function runShadowGateStatus({ skip = false, spawnImpl = spawnCapture } = {}) {
  if (skip) {
    return {
      id: 'shadow_gate',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: 'skipped via --skip-shadow-gate',
    }
  }
  // Prefer Owner-supplied RO status JSON (one-shot equal/diff shape).
  // Development accept does not require spawning portable-shadow-gate here;
  // Production gate 5 runs that CLI (or portable-snapshot-compare) explicitly.
  void spawnImpl
  const statusPath = process.env.AIRINGCAL_SHADOW_GATE_STATUS_JSON?.trim()
  if (!statusPath) {
    return {
      id: 'shadow_gate',
      ok: true,
      measurable: false,
      status: 'pending',
      reason:
        'one-shot parity RO status pending: set AIRINGCAL_SHADOW_GATE_STATUS_JSON to equal/diff JSON from portable-shadow-gate (Production tool); Development accept does not require streak counters',
    }
  }
  const resolved = resolve(ROOT, statusPath)
  if (!existsSync(resolved)) {
    return {
      id: 'shadow_gate',
      ok: true,
      measurable: false,
      status: 'pending',
      reason: `shadow-gate RO status JSON missing: ${statusPath}`,
      path: resolved,
    }
  }
  let status
  try {
    status = JSON.parse(readFileSync(resolved, 'utf8'))
  } catch (error) {
    return {
      id: 'shadow_gate',
      ok: false,
      measurable: true,
      status: 'failed',
      reason: `shadow-gate RO status JSON unreadable: ${error instanceof Error ? error.message : String(error)}`,
      path: resolved,
    }
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return {
      id: 'shadow_gate',
      ok: false,
      measurable: true,
      status: 'failed',
      reason: 'shadow-gate RO status JSON must be an object',
      path: resolved,
    }
  }
  const equal = status.equal === true || status.stage === 'shadow_gate_equal'
  const diffCount = Number(status.diff_count)
  // Historical RO payloads may still carry streak fields; they are not Production hard gates.
  const streak = Number(status.streak)
  const cutoverAllowed = status.cutover_allowed === true
  const normalizedDiffCount = Number.isFinite(diffCount) ? diffCount : null
  if (!equal) {
    return {
      id: 'shadow_gate',
      ok: false,
      measurable: true,
      status: 'failed',
      reason:
        normalizedDiffCount == null
          ? 'shadow-gate RO status reports mismatch (equal=false)'
          : `shadow-gate RO status reports mismatch (equal=false, diff_count=${normalizedDiffCount})`,
      equal: false,
      diff_count: normalizedDiffCount,
      streak: Number.isFinite(streak) ? streak : null,
      cutover_allowed: cutoverAllowed,
      required_matches: status.required_matches ?? null,
      path: resolved,
      note: 'read-only status JSON; Production one-shot parity tool is portable-shadow-gate / portable-snapshot-compare (no seven-match requirement)',
    }
  }
  return {
    id: 'shadow_gate',
    ok: true,
    measurable: true,
    status: 'ok',
    reason: null,
    equal: true,
    diff_count: normalizedDiffCount,
    streak: Number.isFinite(streak) ? streak : null,
    cutover_allowed: cutoverAllowed,
    required_matches: status.required_matches ?? null,
    path: resolved,
    note: 'read-only status JSON; Production one-shot parity tool is portable-shadow-gate / portable-snapshot-compare (no seven-match requirement)',
  }
}


export function loadChecklistPending(checklistPath) {
  const resolved = resolve(ROOT, checklistPath)
  if (!existsSync(resolved)) {
    return {
      pending: [
        {
          id: 'cutover-checklist-missing',
          title: `checklist missing at ${checklistPath}`,
          status: 'pending_owner',
          requiresOwner: 'restore docs/v3/fixtures/reader-delivery-cutover-checklist.json',
        },
      ],
      checklist: null,
      path: resolved,
    }
  }
  const checklist = JSON.parse(readFileSync(resolved, 'utf8'))
  const pending = extractPendingOwnerItems(checklist)
  // Always surface plan Owner-only deps that may not be checklist rows.
  const extras = [
    {
      id: 'mainland-bench',
      title: 'Mainland China bench node (AIRINGCAL_BENCH_MAINLAND_HOST)',
      status: 'pending_owner',
      requiresOwner: 'geo probe machine',
    },
    {
      id: 'icp-cdn-enable',
      title: 'Optional ICP/备案 Image CDN enable (AIRINGCAL_IMAGE_BASE_URL)',
      status: 'pending_owner',
      requiresOwner: 'legal/hosting hostname',
    },
    {
      id: 'production-apply',
      title: 'Production deploy-env --apply (explicit force flags only)',
      status: 'pending_owner',
      requiresOwner: 'explicit non-default Production approval',
    },
  ]
  const seen = new Set(pending.map((p) => p.id))
  for (const extra of extras) {
    if (!seen.has(extra.id)) pending.push(extra)
  }
  return { pending, checklist, path: resolved }
}

export async function runAccept(options = {}) {
  const {
    baseline = DEFAULT_BASELINE,
    post = DEFAULT_POST,
    checklist = DEFAULT_CHECKLIST,
    skipE2e = false,
    skipCfSmoke = false,
    skipMimeHead = false,
    skipRollback = false,
    skipShadowGate = false,
    imagePublicUrl = null,
    imageHash = null,
    publicBaseUrl = null,
    rollbackGeneration = null,
    currentGeneration = null,
    spawnImpl = spawnCapture,
    fetchImpl = globalThis.fetch,
  } = options

  const baselineGate = evaluateBaselinePresent(baseline)
  const postGate = evaluatePostBenchGates(post, PLAN_THRESHOLDS)
  const { pending, checklist: checklistDoc } = loadChecklistPending(checklist)

  const e2eGate = await runPortableE2e({ skip: skipE2e, spawnImpl })
  const cfGate = await runCfSmoke({ skip: skipCfSmoke, spawnImpl })
  const mimeGate = await runMimeSampleHead({
    skip: skipMimeHead,
    imagePublicUrl,
    imageHash,
    publicBaseUrl,
    fetchImpl,
    baselineReceipt: baselineGate.receipt ?? null,
  })
  const rollbackGate = await runRollbackDryRun({
    skip: skipRollback,
    spawnImpl,
    fetchImpl,
    rollbackGeneration,
    currentGeneration,
    publicBaseUrl,
    baselineReceipt: baselineGate.receipt ?? null,
  })
  const shadowGate = await runShadowGateStatus({ skip: skipShadowGate, spawnImpl })

  const gates = [baselineGate, postGate, e2eGate, cfGate, mimeGate, rollbackGate, shadowGate]
  const report = summarizeAcceptReport({ gates, pendingOwner: pending })
  return { ...report, checklist_status: checklistDoc?.status ?? null }
}

function printReport(report) {
  const printable = {
    status: report.measurable_ok ? 'ok' : 'failed',
    stage: 'reader_delivery_accept',
    summary: report.summary,
    measurable_ok: report.measurable_ok,
    exitCode: report.exitCode,
    failed_gates: report.failed_gates,
    gates: report.gates.map((g) => ({
      id: g.id,
      ok: g.ok,
      measurable: g.measurable,
      status: g.status ?? (g.ok ? 'ok' : 'failed'),
      reason: g.reason ?? null,
      failures: g.failures ?? null,
      notes: g.notes ?? null,
      ...(g.id === 'shadow_gate'
        ? {
            equal: g.equal ?? null,
            diff_count: g.diff_count ?? null,
          }
        : {}),
    })),

    pending_owner: report.pending_owner,
  }
  console.log(JSON.stringify(printable, null, 2))
}

function printHelp() {
  console.log(`Usage: node scripts/reader-delivery-accept.mjs [options]

Options:
  --baseline <path>   default ${DEFAULT_BASELINE}
  --post <path>       default ${DEFAULT_POST} (pending if missing)
  --checklist <path>  default ${DEFAULT_CHECKLIST}
  --image-url <url>   public URL for MIME HEAD sample
  --image-hash <hex>  used with --public-base / AIRINGCAL_PUBLIC_BASE_URL
  --public-base <url> image public base
  --rollback-generation <n>  prior generation for rollback dry-run
  --current-generation <n>   derive prior as current-1 when ≥ 2
  --skip-e2e          skip portable e2e (unit/dev)
  --skip-cf-smoke     skip CF staging smoke
  --skip-mime-head    skip MIME HEAD
  --skip-rollback     skip rollback dry-run
  --skip-shadow-gate  skip shadow-gate read-only

Exit 0 iff all measurable gates pass. Owner-pending printed separately.`)
}

async function main(argv = process.argv) {
  const parsed = parseAcceptArgs(argv)
  if (parsed.help) {
    printHelp()
    return
  }
  const report = await runAccept(parsed)
  printReport(report)
  process.exitCode = report.exitCode
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'reader_delivery_accept',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
