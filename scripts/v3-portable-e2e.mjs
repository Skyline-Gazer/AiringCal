#!/usr/bin/env node
/**
 * Portable read-gateway E2E smoke (#71/#73).
 *
 * Publishes a synthetic release into a temp public store (via
 * `scripts/seed-portable-fixture.ts`), boots
 * `packages/v3-read/src/serve-node.ts` — the same server the Compose `web`
 * service runs — and asserts the v2-compatible read surface over real HTTP.
 *
 * No browser, no credentials, no network: CI-safe. A real-browser check of the
 * widget is recorded in `docs/v3/portable-read-gateway.md`.
 *
 * Usage: node scripts/v3-portable-e2e.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = Number(process.env.V3_E2E_PORT ?? 8789)
const BASE = `http://127.0.0.1:${PORT}`
const publicDir = mkdtempSync(join(tmpdir(), 'airingcal-e2e-'))

function log(stage, extra = {}) {
  console.log(JSON.stringify({ status: 'info', stage, ...extra }))
}

function fail(message) {
  console.error(JSON.stringify({ status: 'failed', stage: 'v3_portable_e2e', message }))
  process.exitCode = 1
}

async function waitForServer(child) {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`serve-node exited early (${child.exitCode})`)
    try {
      const res = await fetch(`${BASE}/api/version`)
      if (res.ok) return
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('serve-node did not become ready within 40s')
}

async function check(path, expected) {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.text()
  if (res.status !== expected.status) throw new Error(`${path}: expected ${expected.status}, got ${res.status}`)
  if (expected.cacheControl && res.headers.get('cache-control') !== expected.cacheControl) {
    throw new Error(`${path}: cache-control ${res.headers.get('cache-control')} != ${expected.cacheControl}`)
  }
  for (const fragment of expected.includes ?? []) {
    if (!body.includes(fragment)) throw new Error(`${path}: body missing ${fragment}`)
  }
  log('checked', { path, status: res.status, cacheControl: res.headers.get('cache-control') })
}

async function run() {
  const seed = spawnSync('pnpm', ['exec', 'tsx', 'scripts/seed-portable-fixture.ts', publicDir], {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
  if (seed.status !== 0) throw new Error(`seed failed: ${seed.stderr || seed.stdout}`)
  log('fixture_published', { publicDir })

  const child = spawn('pnpm', ['exec', 'tsx', 'packages/v3-read/src/serve-node.ts'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env, AIRINGCAL_PUBLIC_READ_DIR: publicDir, PORT: String(PORT), NSFW_SHOW: 'true' },
  })
  const devLog = []
  child.stdout?.on('data', (c) => devLog.push(c.toString()))
  child.stderr?.on('data', (c) => devLog.push(c.toString()))

  try {
    await waitForServer(child)
    log('server_ready', { baseUrl: BASE })

    await check('/api/health', { status: 200, includes: ['"ok":true', '"generation":1', '"total_subjects":3', '"scheduler":"external"'] })
    await check('/api/collections?type=watching&page=1&limit=24', {
      status: 200,
      cacheControl: 'public, max-age=30, s-maxage=300, stale-while-revalidate=120',
      includes: ['"subject_id":11', '"limit":24'],
    })
    await check('/api/collections?type=watched&page=1&limit=24', { status: 200, includes: ['"subject_id":21'] })
    await check('/api/calendar', {
      status: 200,
      cacheControl: 'public, max-age=60, s-maxage=600, stale-while-revalidate=300',
      includes: ['"id":11'],
    })
    await check('/api/config?key=nsfw', { status: 200, cacheControl: 'public, max-age=60' })
    await check('/api/version', { status: 200, includes: ['"read":"portable"'] })
    await check('/api/sync/apply', { status: 410, cacheControl: 'no-store' })
    await check(`/image/${'a'.repeat(64)}`, { status: 404 })

    const home = await fetch(`${BASE}/`)
    const html = await home.text()
    if (!html.includes('/src/bangumi.js')) throw new Error('index page must load the widget script')
    log('checked', { path: '/', status: home.status })

    console.log(JSON.stringify({ status: 'ok', stage: 'v3_portable_e2e', checks: 9 }))
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'v3_portable_e2e',
      message: error instanceof Error ? error.message : 'unknown',
      serverLog: devLog.join('').slice(-1500),
    }))
    process.exitCode = 1
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(publicDir, { recursive: true, force: true })
  }
}

await run().catch((error) => fail(error instanceof Error ? error.message : 'unknown'))
