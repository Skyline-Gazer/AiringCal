#!/usr/bin/env node
/**
 * Reader & delivery measurement harness (PR-A / Task 5.1).
 *
 * Records cold/hot/CDN-hit style samples for Development Cloudflare + EdgeOne
 * hosts. Measurement only — does not enforce acceptance thresholds (Task 5.2).
 *
 * Usage:
 *   node scripts/reader-delivery-bench.mjs \
 *     --hosts https://airing-cal-v3-read-staging.r7a.workers.dev,https://test.air.teijp.cn \
 *     --out docs/v3/fixtures/reader-delivery-bench-baseline.json
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const DEFAULT_HOSTS = [
  'https://airing-cal-v3-read-staging.r7a.workers.dev',
  'https://test.air.teijp.cn',
]
const DEFAULT_OUT = 'docs/v3/fixtures/reader-delivery-bench-baseline.json'
const DEFAULT_RUNS = 5
const DEFAULT_TIMEOUT_MS = 20_000

const API_PATHS = [
  { key: 'health', path: '/api/health' },
  { key: 'collections', path: '/api/collections?type=watching&limit=24' },
  { key: 'calendar', path: '/api/calendar' },
]

const CDN_HIT_TOKENS = new Set(['HIT', 'STALE', 'REVALIDATED', 'UPDATING'])

export function median(values) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest-rank: ceil(p/100 * n), clamped to [1, n]
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]
}

export function summarizeTimings(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    median_ms: median(sorted),
    p95_ms: percentile(sorted, 95),
    values_ms: sorted,
  }
}

export function parseBenchArgs(argv = process.argv) {
  const args = argv.slice(2)
  let hosts = [...DEFAULT_HOSTS]
  let out = DEFAULT_OUT
  let runs = DEFAULT_RUNS

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--hosts' && args[i + 1]) {
      hosts = args[++i].split(',').map((h) => h.trim().replace(/\/$/, '')).filter(Boolean)
    } else if (arg === '--out' && args[i + 1]) {
      out = args[++i]
    } else if (arg === '--runs' && args[i + 1]) {
      runs = Math.max(1, Number(args[++i]) || DEFAULT_RUNS)
    } else if (arg === '--help' || arg === '-h') {
      return { help: true, hosts, out, runs }
    }
  }

  return { help: false, hosts, out, runs }
}

export function extractPublishIdentity(body) {
  const publish = body?.data?.publish
  if (!publish || typeof publish !== 'object') return null
  if (publish.generation == null || publish.content_hash == null) return null
  return {
    generation: publish.generation,
    content_hash: publish.content_hash,
    artifact_ref: publish.artifact_ref ?? null,
  }
}

export function extractImageHash(body) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return null
    if (typeof node.hash === 'string' && /^[0-9a-f]{64}$/i.test(node.hash)) return node.hash.toLowerCase()
    if (typeof node.uri === 'string') {
      const m = node.uri.match(/\/image\/([0-9a-f]{64})/i)
      if (m) return m[1].toLowerCase()
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item)
        if (found) return found
      }
      return null
    }
    for (const value of Object.values(node)) {
      const found = walk(value)
      if (found) return found
    }
    return null
  }
  return walk(body)
}

export function isCdnHit(status) {
  if (!status) return false
  return CDN_HIT_TOKENS.has(String(status).toUpperCase())
}

export function buildMainlandReceipt(env = process.env) {
  const host = env.AIRINGCAL_BENCH_MAINLAND_HOST?.trim() || null
  if (!host) {
    return {
      status: 'pending_owner_node',
      host: null,
      note: 'No AIRINGCAL_BENCH_MAINLAND_HOST; do not invent mainland metrics',
    }
  }
  return {
    status: 'configured',
    host,
    note: 'Mainland host configured; metrics are collected only when that host is included in --hosts or a dedicated mainland run',
  }
}

export function buildWidgetReceipt({ browserAvailable = false } = {}) {
  if (!browserAvailable) {
    return {
      status: 'skipped_no_browser',
      lcp_ms: null,
      cls: null,
      inp_ms: null,
      pagination_feedback_ms: null,
    }
  }
  return {
    status: 'pending_browser_run',
    lcp_ms: null,
    cls: null,
    inp_ms: null,
    pagination_feedback_ms: null,
  }
}

export function compareHostIdentities(hosts) {
  const withIdentity = hosts.filter((h) => h.identity?.generation != null && h.identity?.content_hash)
  if (withIdentity.length < 2) {
    return {
      equal: false,
      generation: withIdentity[0]?.identity?.generation ?? null,
      content_hash: withIdentity[0]?.identity?.content_hash ?? null,
      hosts: hosts.map((h) => ({
        host: h.host,
        generation: h.identity?.generation ?? null,
        content_hash: h.identity?.content_hash ?? null,
        status: h.status,
      })),
      note: 'Need at least two hosts with publish identity to compare',
    }
  }
  const first = withIdentity[0].identity
  const equal = withIdentity.every(
    (h) => h.identity.generation === first.generation && h.identity.content_hash === first.content_hash,
  )
  return {
    equal,
    generation: equal ? first.generation : null,
    content_hash: equal ? first.content_hash : null,
    hosts: hosts.map((h) => ({
      host: h.host,
      generation: h.identity?.generation ?? null,
      content_hash: h.identity?.content_hash ?? null,
      status: h.status,
    })),
    note: equal ? 'CF/EO publish generation+content_hash match' : 'Host publish identities differ or some hosts failed',
  }
}

function pickCacheStatus(headers) {
  return (
    headers.get('cf-cache-status')
    || headers.get('eo-cache-status')
    || headers.get('x-cache')
    || headers.get('x-cache-status')
    || null
  )
}

function withQuery(url, params) {
  const u = new URL(url)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return u.toString()
}

async function timedFetch(fetchImpl, url, init = {}, options = {}) {
  const { readBody = true, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const started = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const userSignal = init.signal
  if (userSignal) {
    if (userSignal.aborted) controller.abort()
    else userSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal })
    const ttfbMs = performance.now() - started
    const headers = res.headers
    let bodyText = null
    let bodyJson = null
    if (readBody && (!init.method || init.method === 'GET' || init.method === 'HEAD')) {
      if (init.method === 'HEAD') {
        bodyText = null
      } else {
        bodyText = await res.text()
        const contentType = headers.get('content-type') || ''
        if (contentType.includes('application/json') || bodyText.startsWith('{') || bodyText.startsWith('[')) {
          try {
            bodyJson = JSON.parse(bodyText)
          } catch {
            bodyJson = null
          }
        }
      }
    } else if (res.body && typeof res.body.cancel === 'function') {
      try {
        await res.body.cancel()
      } catch {
        // ignore cancel races
      }
    }
    return {
      ok: res.ok || (res.status >= 300 && res.status < 400),
      status: res.status,
      ttfb_ms: ttfbMs,
      cache_status: pickCacheStatus(headers),
      age: headers.get('age'),
      cache_control: headers.get('cache-control'),
      content_type: headers.get('content-type'),
      location: headers.get('location'),
      bodyJson,
      bodyText,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      status: null,
      ttfb_ms: performance.now() - started,
      cache_status: null,
      age: null,
      cache_control: null,
      content_type: null,
      location: null,
      bodyJson: null,
      bodyText: null,
      error: message.includes('abort') ? `timeout after ${timeoutMs}ms` : message,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function isSuccessfulRun(run) {
  return Boolean(run) && run.ok === true && !run.error
}

function countOkRuns(runs) {
  return runs.filter(isSuccessfulRun).length
}

function sampleMeetsRunQuota(sample, runs) {
  return Boolean(sample) && Number(sample.n_ok) >= runs
}

function pathSamplesComplete(pathMeasured, runs) {
  const samples = pathMeasured?.samples
  if (!samples) return false
  return (
    sampleMeetsRunQuota(samples.first_after_deploy, runs)
    && sampleMeetsRunQuota(samples.repeat_same_isolate, runs)
    && sampleMeetsRunQuota(samples.cdn_shared_hit, runs)
  )
}

function hostSamplesComplete(paths, runs) {
  if (!paths) return false
  return API_PATHS.every((pathSpec) => pathSamplesComplete(paths[pathSpec.key], runs))
}

function aggregateSample(runs, {
  sampleName,
  sampleLabel,
  claimsColdIsolate,
  extraErrors = [],
}) {
  const okRuns = runs.filter(isSuccessfulRun)
  const timings = okRuns.map((r) => r.ttfb_ms)
  const cacheStatuses = okRuns.map((r) => r.cache_status).filter(Boolean)
  const ages = okRuns.map((r) => r.age).filter((v) => v != null)
  const identities = okRuns.map((r) => r.identity).filter(Boolean)
  const errors = [
    ...runs.filter((r) => r.error).map((r) => r.error),
    ...extraErrors,
  ]
  return {
    sample_name: sampleName,
    sample_label: sampleLabel,
    claims_cold_isolate: claimsColdIsolate,
    ttfb_ms: summarizeTimings(timings),
    cache_status_mode: mode(cacheStatuses),
    cache_statuses: cacheStatuses,
    age_samples: ages,
    identities,
    http_statuses: okRuns.map((r) => r.status),
    errors,
    n_ok: okRuns.length,
    n_attempted: okRuns.length + extraErrors.length,
  }
}

function mode(values) {
  if (!values.length) return null
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
  let best = null
  let bestCount = -1
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

async function measurePathSamples({
  baseUrl,
  pathSpec,
  runs,
  fetchImpl,
  isolateRecycleAvailable,
  sleep,
  now,
}) {
  const base = `${baseUrl}${pathSpec.path}`
  const firstLabel = isolateRecycleAvailable ? 'first_after_deploy' : 'first_observed'
  const claimsCold = Boolean(isolateRecycleAvailable)
  const readBody = pathSpec.key === 'health'

  // Per-trial pairing: request A (unique URL) then immediate request B on the
  // exact same URL within soft TTL. Do not batch all firsts then all repeats.
  const firstRuns = []
  const repeatRuns = []
  const pairErrors = []
  const maxPairAttempts = runs * 3
  let pairAttempt = 0
  while (firstRuns.length < runs && pairAttempt < maxPairAttempts) {
    pairAttempt++
    const timeoutMs = pairAttempt <= runs ? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS * 2
    const url = withQuery(base, { bench_bust: `${now()}-${pairAttempt}` })
    const first = await timedFetch(fetchImpl, url, {}, { readBody, timeoutMs })
    const second = await timedFetch(fetchImpl, url, {}, { readBody, timeoutMs })
    if (isSuccessfulRun(first) && isSuccessfulRun(second)) {
      firstRuns.push({
        ...first,
        identity: extractPublishIdentity(first.bodyJson),
        request_url: url,
      })
      repeatRuns.push({
        ...second,
        identity: extractPublishIdentity(second.bodyJson),
        request_url: url,
      })
    } else {
      if (first.error) pairErrors.push(`first: ${first.error}`)
      else if (!isSuccessfulRun(first)) pairErrors.push(`first: HTTP ${first.status}`)
      if (second.error) pairErrors.push(`repeat: ${second.error}`)
      else if (!isSuccessfulRun(second)) pairErrors.push(`repeat: HTTP ${second.status}`)
    }
    await sleep(10)
  }

  // Warm the unbusted URL until HIT (or give up). Query-busting here would
  // prevent shared CDN hits on live hosts.
  let warmed = false
  let warmAttempts = 0
  const warmMax = runs
  while (!warmed && warmAttempts < warmMax) {
    const probe = await timedFetch(fetchImpl, base, {}, { readBody: false })
    warmAttempts++
    if (isCdnHit(probe.cache_status)) {
      warmed = true
      break
    }
    await sleep(20)
  }

  const cdnRuns = []
  const cdnErrors = []
  const maxCdnAttempts = runs * 3
  let cdnAttempt = 0
  while (cdnRuns.length < runs && cdnAttempt < maxCdnAttempts) {
    cdnAttempt++
    const timeoutMs = cdnAttempt <= runs ? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS * 2
    const result = await timedFetch(fetchImpl, base, {}, { readBody, timeoutMs })
    if (isSuccessfulRun(result)) {
      cdnRuns.push({
        ...result,
        identity: extractPublishIdentity(result.bodyJson),
        request_url: base,
      })
    } else if (result.error) {
      cdnErrors.push(result.error)
    } else {
      cdnErrors.push(`HTTP ${result.status}`)
    }
    await sleep(10)
  }

  const firstSample = aggregateSample(firstRuns, {
    sampleName: 'first_after_deploy',
    sampleLabel: firstLabel,
    claimsColdIsolate: claimsCold,
    extraErrors: pairErrors,
  })
  const repeatSample = aggregateSample(repeatRuns, {
    sampleName: 'repeat_same_isolate',
    sampleLabel: 'repeat_same_isolate',
    claimsColdIsolate: false,
    extraErrors: pairErrors,
  })
  const cdnSample = {
    ...aggregateSample(cdnRuns, {
      sampleName: 'cdn_shared_hit',
      sampleLabel: warmed ? 'cdn_shared_hit' : 'cdn_shared_attempted',
      claimsColdIsolate: false,
      extraErrors: cdnErrors,
    }),
    warmed,
    warm_attempts: warmAttempts,
  }

  return {
    path: pathSpec.path,
    samples: {
      first_after_deploy: firstSample,
      repeat_same_isolate: repeatSample,
      cdn_shared_hit: cdnSample,
    },
  }
}


async function probeImage({ baseUrl, hash, fetchImpl }) {
  if (!hash) {
    return {
      status: 'skipped_no_hash',
      reason: 'No image hash discovered from health/collections',
      hash: null,
      redirect_count: null,
      reader_status: null,
      cdn_status: null,
      content_type: null,
      location: null,
    }
  }

  const imageUrl = `${baseUrl}/image/${hash}`
  const redirect = await timedFetch(fetchImpl, imageUrl, { redirect: 'manual' })
  if (redirect.error) {
    return {
      status: 'error',
      reason: redirect.error,
      hash,
      redirect_count: null,
      reader_status: null,
      cdn_status: null,
      content_type: null,
      location: null,
    }
  }

  if (redirect.status !== 302 && redirect.status !== 301) {
    return {
      status: 'unexpected_status',
      reason: `Expected 302 from /image/:hash, got ${redirect.status}`,
      hash,
      redirect_count: 0,
      reader_status: redirect.status,
      cdn_status: null,
      content_type: redirect.content_type,
      location: redirect.location,
      cache_status: redirect.cache_status,
    }
  }

  const location = redirect.location
  if (!location) {
    return {
      status: 'missing_location',
      reason: 'Redirect without Location header',
      hash,
      redirect_count: 1,
      reader_status: redirect.status,
      cdn_status: null,
      content_type: null,
      location: null,
    }
  }

  const absolute = new URL(location, baseUrl).toString()
  let cdn = await timedFetch(fetchImpl, absolute, { method: 'HEAD' }, { readBody: false })
  if (cdn.error || cdn.status === 405 || cdn.status === 501 || cdn.status === null) {
    cdn = await timedFetch(fetchImpl, absolute, { method: 'GET' }, { readBody: false })
  }
  return {
    status: cdn.error ? 'cdn_error' : (cdn.status === 200 ? 'ok' : 'cdn_unexpected_status'),
    reason: cdn.error || null,
    hash,
    redirect_count: 1,
    reader_status: redirect.status,
    cdn_status: cdn.status,
    content_type: cdn.content_type,
    location: absolute,
    reader_cache_status: redirect.cache_status,
    cdn_cache_status: cdn.cache_status,
    cdn_ttfb_ms: cdn.ttfb_ms,
  }
}

async function benchHost({
  host,
  runs,
  fetchImpl,
  isolateRecycleAvailable,
  sleep,
  now,
}) {
  const baseUrl = host.replace(/\/$/, '')
  try {
    const healthProbe = await timedFetch(fetchImpl, `${baseUrl}/api/health`)
    if (healthProbe.error) {
      return {
        host: baseUrl,
        status: 'error',
        error: healthProbe.error,
        identity: null,
        paths: null,
        image: null,
      }
    }
    if (!healthProbe.ok) {
      return {
        host: baseUrl,
        status: 'error',
        error: `health HTTP ${healthProbe.status}`,
        identity: extractPublishIdentity(healthProbe.bodyJson),
        paths: null,
        image: null,
      }
    }

    const identity = extractPublishIdentity(healthProbe.bodyJson)
    const paths = {}
    let discoveredHash = null

    for (const pathSpec of API_PATHS) {
      const measured = await measurePathSamples({
        baseUrl,
        pathSpec,
        runs,
        fetchImpl,
        isolateRecycleAvailable,
        sleep,
        now,
      })
      paths[pathSpec.key] = measured

      if (pathSpec.key === 'collections') {
        // Use a dedicated collections GET to discover hash (and satisfy warm=0 in tests).
        const coll = await timedFetch(fetchImpl, withQuery(`${baseUrl}${pathSpec.path}`, { warm: 0 }))
        discoveredHash = extractImageHash(coll.bodyJson)
      }
    }

    if (!discoveredHash) {
      const coll = await timedFetch(fetchImpl, `${baseUrl}/api/collections?type=watching&limit=24`)
      discoveredHash = extractImageHash(coll.bodyJson)
    }

    const image = await probeImage({ baseUrl, hash: discoveredHash, fetchImpl })

    const complete = hostSamplesComplete(paths, runs)
    return {
      host: baseUrl,
      status: complete ? 'ok' : 'incomplete',
      error: complete
        ? null
        : `one or more samples have n_ok < ${runs} after bounded retries`,
      identity,
      paths,
      image,
    }
  } catch (error) {
    return {
      host: baseUrl,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      identity: null,
      paths: null,
      image: null,
    }
  }
}

export async function runBench({
  hosts,
  out,
  runs = DEFAULT_RUNS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  env = process.env,
  browserAvailable = false,
  isolateRecycleAvailable = false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!hosts?.length) throw new Error('--hosts requires at least one URL')

  const hostResults = await Promise.all(hosts.map((host) => benchHost({
    host,
    runs,
    fetchImpl,
    isolateRecycleAvailable,
    sleep,
    now,
  })))

  const receipt = {
    schema_version: 1,
    kind: 'reader_delivery_bench',
    captured_at_unix_ms: now(),
    thresholds_enforced: false,
    protocol: {
      runs_per_sample: runs,
      sample_names: ['first_after_deploy', 'repeat_same_isolate', 'cdn_shared_hit'],
      note: 'Query busting is not labeled cold-isolate; first_observed used when isolate recycle unavailable; repeat_same_isolate is immediate second request on the same URL per trial',
      isolate_recycle_available: isolateRecycleAvailable,
    },
    hosts: hostResults,
    cf_vs_eo: compareHostIdentities(hostResults),
    widget: buildWidgetReceipt({ browserAvailable }),
    mainland: buildMainlandReceipt(env),
  }
  receipt.status = hostResults.every((h) => h.status === 'ok')
    ? 'ok'
    : (hostResults.some((h) => h.status === 'error') ? 'failed' : 'incomplete')

  if (out) {
    const abs = resolve(out)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  }

  return receipt
}

function printHelp() {
  console.log(`Usage: node scripts/reader-delivery-bench.mjs [--hosts url1,url2] [--out path] [--runs N]

Defaults:
  --hosts ${DEFAULT_HOSTS.join(',')}
  --out ${DEFAULT_OUT}
  --runs ${DEFAULT_RUNS}

Does not enforce acceptance thresholds (PR-A / Task 5.1).`)
}

async function main(argv = process.argv) {
  const parsed = parseBenchArgs(argv)
  if (parsed.help) {
    printHelp()
    return
  }
  const receipt = await runBench({
    hosts: parsed.hosts,
    out: parsed.out,
    runs: parsed.runs,
  })
  console.log(JSON.stringify({
    status: receipt.status,
    stage: 'reader_delivery_bench',
    out: parsed.out,
    hosts: receipt.hosts.map((h) => ({ host: h.host, status: h.status, error: h.error ?? null })),
    cf_vs_eo_equal: receipt.cf_vs_eo.equal,
    mainland: receipt.mainland.status,
    widget: receipt.widget.status,
  }))
}

const isDirect = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  main().catch((error) => {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'reader_delivery_bench',
      message: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  })
}
