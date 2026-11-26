import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildMainlandReceipt,
  buildWidgetReceipt,
  compareHostIdentities,
  extractImageHash,
  extractPublishIdentity,
  isCdnHit,
  median,
  parseBenchArgs,
  percentile,
  runBench,
  summarizeTimings,
} from './reader-delivery-bench.mjs'

test('median and p95 summarize odd and even samples without inventing values', () => {
  assert.equal(median([10]), 10)
  assert.equal(median([10, 30, 20]), 20)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5)
  assert.deepEqual(summarizeTimings([100, 200, 150, 180, 120]), {
    n: 5,
    median_ms: 150,
    p95_ms: 200,
    values_ms: [100, 120, 150, 180, 200],
  })
})

test('parseBenchArgs reads --hosts and --out with plan defaults', () => {
  const parsed = parseBenchArgs([
    'node',
    'scripts/reader-delivery-bench.mjs',
    '--hosts',
    'https://cf.example,https://eo.example',
    '--out',
    'docs/v3/fixtures/reader-delivery-bench-baseline.json',
  ])
  assert.deepEqual(parsed.hosts, ['https://cf.example', 'https://eo.example'])
  assert.equal(parsed.out, 'docs/v3/fixtures/reader-delivery-bench-baseline.json')
  assert.equal(parsed.runs, 5)

  const defaults = parseBenchArgs(['node', 'scripts/reader-delivery-bench.mjs'])
  assert.deepEqual(defaults.hosts, [
    'https://airing-cal-v3-read-staging.r7a.workers.dev',
    'https://test.air.teijp.cn',
  ])
  assert.equal(defaults.out, 'docs/v3/fixtures/reader-delivery-bench-baseline.json')
})

test('extractPublishIdentity and extractImageHash read health/collections bodies', () => {
  assert.deepEqual(
    extractPublishIdentity({
      ok: true,
      data: {
        publish: {
          generation: 3,
          content_hash: 'abc',
          artifact_ref: 'snapshots/v1/3-abc.json',
        },
      },
    }),
    { generation: 3, content_hash: 'abc', artifact_ref: 'snapshots/v1/3-abc.json' },
  )
  assert.equal(extractPublishIdentity({ ok: false }), null)
  assert.equal(
    extractImageHash({
      data: [
        {
          images: {
            common: { hash: 'f'.repeat(64), uri: `/image/${'f'.repeat(64)}` },
          },
        },
      ],
    }),
    'f'.repeat(64),
  )
  assert.equal(extractImageHash({ data: [] }), null)
})

test('isCdnHit recognizes platform HIT tokens and rejects miss/dynamic', () => {
  assert.equal(isCdnHit('HIT'), true)
  assert.equal(isCdnHit('hit'), true)
  assert.equal(isCdnHit('MISS'), false)
  assert.equal(isCdnHit('DYNAMIC'), false)
  assert.equal(isCdnHit('EXPIRED'), false)
  assert.equal(isCdnHit(null), false)
})

test('mainland defaults to pending_owner_node unless AIRINGCAL_BENCH_MAINLAND_HOST is set', () => {
  assert.deepEqual(buildMainlandReceipt({}), {
    status: 'pending_owner_node',
    host: null,
    note: 'No AIRINGCAL_BENCH_MAINLAND_HOST; do not invent mainland metrics',
  })
  assert.equal(
    buildMainlandReceipt({ AIRINGCAL_BENCH_MAINLAND_HOST: 'https://cn.example' }).status,
    'configured',
  )
  assert.equal(
    buildMainlandReceipt({ AIRINGCAL_BENCH_MAINLAND_HOST: 'https://cn.example' }).host,
    'https://cn.example',
  )
})

test('widget receipt skips honestly when browser tooling is unavailable', () => {
  assert.deepEqual(buildWidgetReceipt({ browserAvailable: false }), {
    status: 'skipped_no_browser',
    lcp_ms: null,
    cls: null,
    inp_ms: null,
    pagination_feedback_ms: null,
  })
})

test('compareHostIdentities reports equality without fabricating hashes', () => {
  const equal = compareHostIdentities([
    { host: 'https://cf', identity: { generation: 3, content_hash: 'aa' } },
    { host: 'https://eo', identity: { generation: 3, content_hash: 'aa' } },
  ])
  assert.equal(equal.equal, true)
  assert.equal(equal.generation, 3)
  assert.equal(equal.content_hash, 'aa')

  const mismatch = compareHostIdentities([
    { host: 'https://cf', identity: { generation: 3, content_hash: 'aa' } },
    { host: 'https://eo', identity: { generation: 2, content_hash: 'bb' } },
  ])
  assert.equal(mismatch.equal, false)
  assert.ok(Array.isArray(mismatch.hosts))
})

test('runBench writes fixture with named samples, no threshold gating, honest host errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-delivery-bench-'))
  const out = join(dir, 'baseline.json')
  const calls = []

  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, method: init.method || 'GET' })
    if (url.includes('https://down.example')) {
      throw new Error('connect ECONNREFUSED')
    }
    if (url.includes('/api/health')) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            publish: {
              generation: 7,
              content_hash: 'c'.repeat(64),
              artifact_ref: `snapshots/v1/7-${'c'.repeat(64)}.json`,
            },
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=60',
            'cf-cache-status': url.includes('bust=') ? 'MISS' : 'DYNAMIC',
          },
        },
      )
    }
    if (url.includes('/api/collections')) {
      const hit = !url.includes('warm=0')
      return new Response(
        JSON.stringify({
          data: [
            {
              images: {
                common: {
                  hash: 'a'.repeat(64),
                  uri: `/image/${'a'.repeat(64)}`,
                },
              },
            },
          ],
          total: 1,
          page: 1,
          limit: 24,
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=30, s-maxage=60',
            'cf-cache-status': hit ? 'HIT' : 'MISS',
            age: hit ? '12' : '0',
          },
        },
      )
    }
    if (url.includes('/api/calendar')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'cf-cache-status': 'HIT',
        },
      })
    }
    if (url.includes('/image/')) {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://cdn.example/images/${'a'.repeat(64)}/original`,
          'cf-cache-status': 'DYNAMIC',
        },
      })
    }
    if (url.startsWith('https://cdn.example/')) {
      return new Response('img', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response('missing', { status: 404 })
  }

  try {
    const receipt = await runBench({
      hosts: ['https://up.example', 'https://down.example'],
      out,
      runs: 5,
      fetchImpl,
      now: () => 1_700_000_000_000,
      env: {},
      browserAvailable: false,
      isolateRecycleAvailable: false,
      sleep: async () => {},
    })

    assert.equal(receipt.schema_version, 1)
    assert.equal(receipt.thresholds_enforced, false)
    assert.equal(receipt.mainland.status, 'pending_owner_node')
    assert.equal(receipt.widget.status, 'skipped_no_browser')
    assert.equal(receipt.widget.lcp_ms, null)

    const up = receipt.hosts.find((h) => h.host === 'https://up.example')
    const down = receipt.hosts.find((h) => h.host === 'https://down.example')
    assert.ok(up)
    assert.ok(down)
    assert.equal(down.status, 'error')
    assert.match(down.error, /ECONNREFUSED/)
    assert.equal(up.status, 'ok')
    assert.equal(up.identity.generation, 7)

    for (const pathKey of ['health', 'collections', 'calendar']) {
      const samples = up.paths[pathKey].samples
      assert.ok(samples.first_after_deploy)
      assert.equal(samples.first_after_deploy.sample_label, 'first_observed')
      assert.equal(samples.first_after_deploy.claims_cold_isolate, false)
      assert.equal(samples.first_after_deploy.ttfb_ms.n, 5)
      assert.equal(typeof samples.first_after_deploy.ttfb_ms.median_ms, 'number')
      assert.equal(typeof samples.first_after_deploy.ttfb_ms.p95_ms, 'number')
      assert.ok(samples.repeat_same_isolate.ttfb_ms.n === 5)
      assert.ok(samples.cdn_shared_hit.ttfb_ms.n === 5)
    }

    assert.equal(up.image.status, 'ok')
    assert.equal(up.image.redirect_count, 1)
    assert.equal(up.image.cdn_status, 200)
    assert.equal(up.image.content_type, 'image/jpeg')
    assert.equal(up.image.hash, 'a'.repeat(64))

    assert.equal(receipt.cf_vs_eo.equal, false)
    assert.ok(receipt.cf_vs_eo.note)

    const written = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(written.schema_version, 1)
    assert.equal(written.thresholds_enforced, false)
    assert.equal(written.hosts.length, 2)

    // Unique-query busting may appear on first_observed warm attempts, but must not claim cold isolate.
    assert.equal(
      calls.some((c) => c.url.includes('/api/collections') && c.url.includes('bench_bust=')),
      true,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('measurePathSamples pairs first→second on the same URL per trial before CDN warm', async () => {
  const healthCalls = []
  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.includes('/api/health')) healthCalls.push(url)
    return new Response(JSON.stringify({ ok: true, data: { publish: { generation: 1, content_hash: 'x' } } }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cf-cache-status': url.includes('bench_bust=') ? 'MISS' : 'HIT',
      },
    })
  }

  const dir = mkdtempSync(join(tmpdir(), 'reader-delivery-bench-pair-'))
  const out = join(dir, 'out.json')
  try {
    await runBench({
      hosts: ['https://pair.example'],
      out,
      runs: 3,
      fetchImpl,
      now: (() => {
        let t = 1_700_000_000_000
        return () => ++t
      })(),
      env: {},
      browserAvailable: false,
      isolateRecycleAvailable: false,
      sleep: async () => {},
    })

    // Drop the initial health probe from benchHost; keep measurePathSamples traffic.
    const measured = healthCalls.slice(1)
    assert.ok(measured.length >= 6, `expected at least 3 paired trials, got ${measured.length}`)

    for (let i = 0; i < 3; i++) {
      const first = measured[i * 2]
      const second = measured[i * 2 + 1]
      assert.ok(first.includes('bench_bust='), `trial ${i} first request should be busted: ${first}`)
      assert.equal(
        second,
        first,
        `trial ${i} repeat must reuse the exact same URL as its paired first (isolate affinity)`,
      )
    }

    // CDN warm/hit phase starts only after all first→second pairs.
    const afterPairs = measured.slice(6)
    assert.ok(afterPairs.length >= 1)
    assert.equal(
      afterPairs.every((u) => !u.includes('bench_bust=')),
      true,
      'CDN warm/hit requests must use the unbusted URL after pairing',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('runBench marks host incomplete when a sample stays below N after retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-delivery-bench-incomplete-'))
  const out = join(dir, 'out.json')
  let healthGets = 0
  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    if (url.includes('/api/health')) {
      healthGets++
      // After the initial benchHost probe, fail enough timed samples so retries cannot fill N=3.
      // Probe + pairs use GET; fail every request after a few successes.
      if (healthGets > 3) {
        throw new Error('timeout after 20000ms')
      }
      return new Response(
        JSON.stringify({ ok: true, data: { publish: { generation: 1, content_hash: 'y'.repeat(64) } } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'cf-cache-status': 'DYNAMIC' },
        },
      )
    }
    if (url.includes('/api/collections') || url.includes('/api/calendar')) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cf-cache-status': 'HIT' },
      })
    }
    return new Response('missing', { status: 404 })
  }

  try {
    const receipt = await runBench({
      hosts: ['https://thin.example'],
      out,
      runs: 3,
      fetchImpl,
      now: () => 1_700_000_000_000,
      env: {},
      browserAvailable: false,
      isolateRecycleAvailable: false,
      sleep: async () => {},
    })
    const host = receipt.hosts[0]
    assert.equal(host.status, 'incomplete')
    assert.match(host.error, /n_ok < 3/)
    assert.equal(receipt.status, 'incomplete')
    assert.ok(host.paths.health.samples.first_after_deploy.n_ok < 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('runBench excludes HTTP 5xx from n_ok and marks host incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reader-delivery-bench-5xx-'))
  const out = join(dir, 'out.json')
  let calendarGets = 0
  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.includes('/api/calendar')) {
      calendarGets++
      // Always 545: must never count toward N completeness even without thrown errors.
      return new Response('edge function error', {
        status: 545,
        headers: { 'content-type': 'text/plain', 'eo-cache-status': 'DYNAMIC' },
      })
    }
    if (url.includes('/api/health') || url.includes('/api/collections')) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            publish: { generation: 2, content_hash: 'a'.repeat(64) },
            items: [{ hash: 'b'.repeat(64) }],
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'cf-cache-status': 'HIT' },
        },
      )
    }
    if (url.includes('/image/')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/img' },
      })
    }
    if (url.includes('cdn.example')) {
      return new Response(null, {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      })
    }
    return new Response('missing', { status: 404 })
  }

  try {
    const receipt = await runBench({
      hosts: ['https://eo-5xx.example'],
      out,
      runs: 3,
      fetchImpl,
      now: () => 1_700_000_000_100,
      env: {},
      browserAvailable: false,
      isolateRecycleAvailable: false,
      sleep: async () => {},
    })
    const host = receipt.hosts[0]
    assert.ok(calendarGets > 0, 'calendar path must be exercised')
    assert.equal(host.status, 'incomplete')
    assert.match(host.error, /n_ok < 3/)
    assert.equal(receipt.status, 'incomplete')
    const calendar = host.paths.calendar.samples
    assert.ok(calendar.first_after_deploy.n_ok < 3)
    assert.equal(calendar.first_after_deploy.n_ok, 0)
    assert.ok(
      calendar.first_after_deploy.errors.some((e) => /HTTP 545/.test(e)),
      'errors should record HTTP 545 rather than counting it as success',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})




test('importing the CLI module as a library does not auto-run main', async () => {
  assert.equal(typeof runBench, 'function')
  assert.equal(typeof parseBenchArgs, 'function')
  assert.equal(typeof summarizeTimings, 'function')
})
