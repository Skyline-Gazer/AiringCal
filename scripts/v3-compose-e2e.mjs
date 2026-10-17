#!/usr/bin/env node
/**
 * Compose-stack E2E for the portable v3 stack (#70).
 *
 * Exercises the *real* Docker image and stack that operators run — not the
 * host `serve-node.ts` path (that is `scripts/v3-portable-e2e.mjs`):
 *
 *   1. `docker compose build` for the web service (deploy/v3/Dockerfile)
 *   2. seed a synthetic release into the `airingcal-data` volume
 *   3. `compose up -d web` and wait for the container healthcheck
 *   4. assert the read surface over the published port
 *   5. `compose down -v` (always)
 *
 * Requires a working Docker daemon (CI runners have one; this script never
 * provisions paid resources). Usage: node scripts/v3-compose-e2e.mjs
 */
import { spawnSync } from 'node:child_process'

const PORT = Number(process.env.V3_COMPOSE_E2E_PORT ?? 8790)
const BASE = `http://127.0.0.1:${PORT}`
const compose = ['-f', 'deploy/v3/docker-compose.yml']

function log(stage, extra = {}) {
  console.log(JSON.stringify({ status: 'info', stage, ...extra }))
}

function fail(message) {
  console.error(JSON.stringify({ status: 'failed', stage: 'v3_compose_e2e', message }))
  process.exitCode = 1
}

function run(args, env = {}, timeout = 1_800_000) {
  const result = spawnSync('docker', ['compose', ...compose, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, AIRINGCAL_WEB_PORT: String(PORT), ...env },
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw new Error(`docker compose ${args[0]} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).slice(-1500)}`)
  }
  return result.stdout ?? ''
}

async function waitForHealthy() {
  const deadline = Date.now() + 180_000
  let lastError = 'never probed'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`)
      if (res.ok) return
      lastError = `health status ${res.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'unknown'
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`compose web service did not become healthy within 180s (last: ${lastError})`)
}

async function check(path, expected) {
  const res = await fetch(`${BASE}${path}`)
  const body = await res.text()
  if (res.status !== expected.status) throw new Error(`${path}: expected ${expected.status}, got ${res.status}`)
  for (const fragment of expected.includes ?? []) {
    if (!body.includes(fragment)) throw new Error(`${path}: body missing ${fragment}`)
  }
  log('checked', { path, status: res.status })
}

async function runE2E() {
  log('build_start')
  run(['build', 'web'])
  log('build_done')

  // Seed a synthetic release into the shared volume using the same image.
  run(['run', '--rm', '-e', 'AIRINGCAL_PUBLIC_READ_DIR=/data/public', '-e', 'AIRINGCAL_BUILDER_SQLITE_PATH=/data/builder.sqlite', 'web',
    'pnpm', 'exec', 'tsx', 'scripts/seed-portable-fixture.ts', '/data/public'])
  log('fixture_seeded')

  run(['up', '-d', 'web'])
  await waitForHealthy()
  log('service_healthy', { baseUrl: BASE })

  await check('/api/health', { status: 200, includes: ['"ok":true', '"generation":1', '"total_subjects":3'] })
  await check('/api/collections?type=watching&page=1&limit=24', { status: 200, includes: ['"subject_id":11'] })
  await check('/api/calendar', { status: 200, includes: ['"id":11'] })
  await check('/api/version', { status: 200, includes: ['"read":"portable"'] })
  await check('/api/sync/apply', { status: 410 })

  console.log(JSON.stringify({ status: 'ok', stage: 'v3_compose_e2e', checks: 5 }))
}

try {
  await runE2E().catch((error) => fail(error instanceof Error ? error.message : 'unknown'))
} finally {
  try {
    run(['down', '-v'])
  } catch (error) {
    console.error(JSON.stringify({ status: 'warn', stage: 'v3_compose_e2e', message: `cleanup failed: ${error.message}` }))
  }
}
