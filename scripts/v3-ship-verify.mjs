#!/usr/bin/env node
/**
 * v3 ship-readiness verifier (Owner directive 2026-11-25 §17).
 *
 * Read-only end-to-end probes against a running Viewer: API shape, release
 * pointer identity, method allowlist (405), conditional GET (ETag/304),
 * checkpoint-path isolation, static Widget page, and image delivery
 * (original + optional thumb). Never mutates any state.
 *
 * Modes:
 *   --base <url>          probe an already-running Viewer (live hosts included)
 *   --public-dir <dir>    spawn packages/v3-read serve-node over a mirrored
 *                         public tree (same layout as the R2 public bucket)
 *   --bucket <name>       positive private-object proof: read-only S3
 *                         list+HEAD of a real checkpoints/ object (needs
 *                         AIRINGCAL_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY and
 *                         AIRINGCAL_S3_ENDPOINT or *_ACCOUNT_ID), then the
 *                         anonymous GET/HEAD denial through --base
 *   --allow-unproven-isolation
 *                         explicit, JSON-visible skip of that proof
 *
 * Usage:
 *   node scripts/v3-ship-verify.mjs --base https://airingcal.teijp.cn --json
 *   node scripts/v3-ship-verify.mjs --base https://w.r7a.workers.dev --bucket airingcal-development --json
 *   node scripts/v3-ship-verify.mjs --public-dir ./mirror --json
 *
 * Exit 0 only when every executed check passes.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IDENTITY_PATHS = ['/api/collections', '/api/calendar', '/api/cache']
const RELEASE_REF = /^[0-9]+-[0-9a-f]{64}$/

function parseArgs(argv) {
  const args = { json: false, port: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--base') args.base = argv[++i]
    else if (a === '--public-dir') args.publicDir = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--bucket') args.bucket = argv[++i]
    else if (a === '--allow-unproven-isolation') args.allowUnprovenIsolation = true
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.base && !args.publicDir) throw new Error('need --base <url> or --public-dir <dir>')
  if (args.base && args.publicDir) throw new Error('--base and --public-dir are exclusive')
  if (args.bucket && !args.base) throw new Error('--bucket requires --base (the reader origin to probe)')
  if (args.publicDir && !existsSync(resolve(args.publicDir, 'public/current-release.json'))) {
    throw new Error(`--public-dir lacks public/current-release.json: ${args.publicDir}`)
  }
  return args
}

async function fetchHeadless(base, path, init = {}) {
  const res = await fetch(new URL(path, base), { redirect: 'manual', ...init })
  await res.body?.cancel().catch(() => {})
  return res
}

/** Pure classification over probe records so tests can drive it offline. */
export function evaluateProbeResults(probes) {
  const failures = probes.filter((p) => p.pass !== true)
  return { pass: probes.length > 0 && failures.length === 0, failed: failures.map((p) => p.name) }
}

/**
 * Positive private-object proof over an injected store ({ list(prefix),
 * head(key) }) and anonymous probe function. Read-only by construction —
 * the store adapter is never given write capability here.
 */
export async function runPrivateObjectProof(rec, { bucket, store, probe }) {
  let listed
  try {
    listed = await store.list('checkpoints/')
  } catch (error) {
    rec('private-object-proof', false, `S3 list checkpoints/ on ${bucket} failed: ${error?.message ?? error}`)
    return
  }
  const keys = (Array.isArray(listed) ? listed : []).filter(
    (k) => typeof k === 'string' && k.startsWith('checkpoints/') && !k.endsWith('/'),
  )
  if (keys.length === 0) {
    rec('private-object-proof', false, `bucket ${bucket} exposes no checkpoints/ objects — isolation has nothing to prove`)
    return
  }
  const key = keys.includes('checkpoints/latest.sqlite') ? 'checkpoints/latest.sqlite' : keys[0]
  let head = null
  try {
    head = await store.head(key)
  } catch {
    head = null
  }
  if (!head) {
    rec('private-object-exists', false, `${key} listed but S3 HEAD returned nothing on ${bucket}`)
    return
  }
  rec('private-object-exists', true, `${key} present in ${bucket} (size=${head.size ?? '?'})`)
  for (const method of ['GET', 'HEAD']) {
    let status = 0
    try {
      status = (await probe(key, method))?.status ?? 0
    } catch (error) {
      rec(`anon-${method.toLowerCase()}-private-key-denied`, false, `probe error: ${error?.message ?? error}`)
      continue
    }
    rec(`anon-${method.toLowerCase()}-private-key-denied`, status === 403 || status === 404, `/${key} -> ${status}`)
  }
}

export async function runProbes(base, opts = {}) {
  const probes = []
  const rec = (name, pass, detail) => { probes.push({ name, pass: pass === true, detail }) }

  // Static Viewer page (Widget HTML shell).
  const home = await fetch(`${base}/`, { redirect: 'manual' })
  const homeBody = await home.text().catch(() => '')
  rec('static-index-200', home.status === 200, `status=${home.status}`)
  rec('static-index-widget-markup', /data-bgm-|bgm-container/.test(homeBody), `html_bytes=${homeBody.length}`)
  const asset = await fetchHeadless(base, '/src/bangumi.js')
  rec('static-widget-js-200', asset.status === 200, `status=${asset.status}`)

  // Release pointer identity (mirror mode reads it from disk; live bucket
  // domains serve it raw; managed Viewer origins may not expose it at all).
  let release = null
  if (opts.release) {
    release = opts.release
    rec('release-pointer-readable', true, 'read from --public-dir')
  } else {
    const relRes = await fetch(new URL('/public/current-release.json', base).href).catch(() => null)
    if (relRes?.status === 200) { try { release = await relRes.json() } catch { release = null } }
    rec('release-pointer-readable', !!release, `status=${relRes?.status ?? 'fetch-error'}`)
  }

  // API shape + pointer consistency + image refs (first cache payload).
  const cacheRes = await fetch(new URL('/api/cache', base).href)
  const cacheOk = cacheRes.status === 200
  rec('api-cache-200', cacheOk, `status=${cacheRes.status}`)
  let cache = null
  if (cacheOk) { try { cache = await cacheRes.json() } catch { cache = null } }
  rec('api-cache-json', !!cache, `status=${cacheRes.status}`)
  if (release) {
    rec('pointer-artifact-ref-shape',
      RELEASE_REF.test(String(release.artifact_ref ?? '').replace(/^snapshots\/v1\//, '').replace(/\.json$/, '')),
      `artifact_ref=${release.artifact_ref}`)
  }

  // Conditional GET on identity endpoints.
  for (const p of IDENTITY_PATHS) {
    const a = await fetchHeadless(base, p)
    const etag = a.headers.get('etag')
    rec(`${p}-200`, a.status === 200, `status=${a.status}`)
    rec(`${p}-etag`, !!etag && (release ? etag.includes(String(release.generation)) : true),
      `etag=${etag}`)
    if (etag) {
      const b = await fetchHeadless(base, p, { headers: { 'if-none-match': etag } })
      rec(`${p}-inm-304`, b.status === 304, `status=${b.status}`)
    } else {
      rec(`${p}-inm-304`, false, 'no etag to conditionalize')
    }
  }

  // Method allowlist.
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await fetchHeadless(base, '/api/collections', { method: m })
    const allow = (res.headers.get('allow') ?? '').toUpperCase()
    rec(`${m}-collections-405`, res.status === 405 && allow.includes('GET') && allow.includes('HEAD'),
      `status=${res.status} allow=${allow || 'none'}`)
  }

  // Checkpoint paths must not be served by the Viewer.
  const cp = await fetchHeadless(base, '/checkpoints/latest.sqlite')
  rec('checkpoints-path-404', cp.status === 404, `status=${cp.status}`)

  // Positive private-object proof (#183 P4): an anonymous 404 only isolates
  // if the object DEMONSTRABLY exists in the private store. With --bucket +
  // read-only S3 credentials (or a --public-dir mirror that actually carries
  // checkpoints/) pick a real checkpoint key, prove existence via HEAD, then
  // require 403/404 for GET and HEAD through the same public base. Without
  // proof capability the run fails closed unless the operator explicitly
  // passes --allow-unproven-isolation (recorded in JSON, never silent).
  if (opts.objectStore) {
    await runPrivateObjectProof(rec, {
      bucket: opts.bucket ?? 'mirror',
      store: opts.objectStore,
      probe: (key, method) =>
        fetchHeadless(base, `/${key.split('/').map(encodeURIComponent).join('/')}`, { method }),
    })
  } else {
    rec(
      'private-object-proof',
      opts.allowUnprovenIsolation === true,
      opts.allowUnprovenIsolation === true
        ? 'explicitly skipped via --allow-unproven-isolation (NOT a positive isolation proof)'
        : 'existence unverified: pass --bucket with read-only S3 credentials, or use --public-dir containing checkpoints/, or state the skip with --allow-unproven-isolation',
    )
  }

  // Image delivery: first hash-bearing image ref across snapshot payloads.
  const images = []
  const walk = (v) => {
    if (!v || typeof v !== 'object') return
    if (typeof v.hash === 'string' && typeof v.uri === 'string') images.push(v)
    for (const child of Object.values(v)) walk(child)
  }
  walk(cache)
  for (const p of ['/api/collections', '/api/calendar']) {
    const payload = await fetch(new URL(p, base).href)
      .then((r) => (r.status === 200 ? r.json() : null))
      .catch(() => null)
    walk(payload)
  }
  let refs = images.filter((i) => /^[0-9a-f]{64}$/.test(i.hash))
  if (opts.publicDir) {
    // Partial mirrors only carry sampled objects; probe refs that exist on disk.
    refs = refs.filter((i) => existsSync(resolve(opts.publicDir, 'images', i.hash, 'original')))
  }
  refs = refs.slice(0, 5)
  let served = 0
  let thumbs = 0
  for (const ref of refs) {
    const orig = await fetchHeadless(base, ref.uri)
    const ctype = orig.headers.get('content-type') ?? ''
    await orig.body?.cancel().catch(() => {})
    if (orig.status === 200 && ctype.startsWith('image/')) served += 1
    const thumb = await fetchHeadless(base, `${ref.uri}/thumb`)
    const ttype = thumb.headers.get('content-type') ?? ''
    if (thumb.status === 200 && ttype.startsWith('image/')) thumbs += 1
    else if (thumb.status !== 404) { rec(`image-thumb-bad-${ref.hash.slice(0, 8)}`, false, `status=${thumb.status} type=${ttype}`) }
    await thumb.body?.cancel().catch(() => {})
  }
  rec('image-original-served', refs.length > 0 && served > 0, `served=${served}/${refs.length}`)

  return probes
}

/** Read-only fs-backed store adapter for --public-dir mirrors. */
export function mirrorObjectStore(dir) {
  return {
    async list(prefix) {
      const out = []
      const walk = (abs, rel) => {
        let entries
        try {
          entries = readdirSync(abs, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(join(abs, e.name), childRel)
          else if (e.isFile()) out.push(childRel)
        }
      }
      walk(resolve(dir, prefix.replace(/\/+$/, '')), prefix.replace(/\/+$/, ''))
      return out
    },
    async head(key) {
      const abs = resolve(dir, key)
      if (!existsSync(abs)) return null
      return { size: statSync(abs).size, etag: null, contentType: null }
    },
  }
}

async function startLocalServer(publicDir, requestedPort) {
  const port = requestedPort || 49152 + Math.floor(Math.random() * 16383)
  const child = spawn('pnpm', ['exec', 'tsx', resolve(ROOT, 'packages/v3-read/src/serve-node.ts')], {
    cwd: ROOT,
    env: { ...process.env, AIRINGCAL_PUBLIC_READ_DIR: resolve(publicDir), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const url = await new Promise((ok, fail) => {
    let buf = ''
    const onData = (chunk) => {
      buf += String(chunk)
      if (/portable_read_listen/.test(buf)) { clearTimeout(t); ok(`http://127.0.0.1:${port}`) }
      if (/EADDRINUSE/.test(buf)) { clearTimeout(t); fail(new Error(`port ${port} in use`)) }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (c) => fail(new Error(`serve-node exited ${c}: ${buf.slice(0, 400)}`)))
    const t = setTimeout(() => fail(new Error(`serve-node did not start: ${buf.slice(0, 400)}`)), 20000)
  })
  return { child, base: url }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let server = null
  let base = args.base
  let release = null
  let objectStore = null
  try {
    if (args.publicDir) {
      server = await startLocalServer(args.publicDir, args.port)
      base = server.base
      for (let i = 0; i < 25; i += 1) {
        try { await fetchHeadless(base, '/api/cache'); break } catch { await new Promise((r) => setTimeout(r, 200)) }
      }
      release = JSON.parse(readFileSync(resolve(args.publicDir, 'public/current-release.json'), 'utf8'))
      if (existsSync(resolve(args.publicDir, 'checkpoints'))) {
        objectStore = mirrorObjectStore(args.publicDir)
      }
    } else if (args.bucket) {
      const { createDefaultObjectStore } = await import('./deploy-env-live-io.mjs')
      const accessKeyId = String(process.env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()
      const secretAccessKey = String(process.env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()
      const accountId = String(process.env.AIRINGCAL_S3_ACCOUNT_ID ?? process.env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ?? '').trim()
      const endpoint = String(process.env.AIRINGCAL_S3_ENDPOINT ?? (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).trim()
      objectStore =
        accessKeyId && secretAccessKey && endpoint
          ? createDefaultObjectStore({
              bucket: args.bucket,
              endpoint,
              region: String(process.env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
              accessKeyId,
              secretAccessKey,
            })
          : {
              async list() {
                throw new Error(
                  'S3 credentials incomplete (need AIRINGCAL_S3_ACCESS_KEY_ID + AIRINGCAL_S3_SECRET_ACCESS_KEY + AIRINGCAL_S3_ENDPOINT or *_ACCOUNT_ID)',
                )
              },
            }
    }
    const probes = await runProbes(base, {
      release,
      publicDir: args.publicDir && resolve(args.publicDir),
      objectStore,
      bucket: args.bucket ?? null,
      allowUnprovenIsolation: args.allowUnprovenIsolation === true,
    })
    const verdict = evaluateProbeResults(probes)
    const out = {
      tool: 'v3-ship-verify',
      asOf: new Date().toISOString().slice(0, 10),
      base,
      pass: verdict.pass,
      failed: verdict.failed,
      checks: probes,
    }
    if (args.json) console.log(JSON.stringify(out, null, 2))
    else {
      for (const p of probes) console.log(`${p.pass ? 'PASS' : p.pass === null ? 'SKIP' : 'FAIL'}  ${p.name}${p.detail ? `  (${p.detail})` : ''}`)
      console.log(verdict.pass ? `ALL CHECKS PASS (${probes.length})` : `FAILED: ${verdict.failed.join(', ')}`)
    }
    process.exitCode = verdict.pass ? 0 : 1
  } catch (err) {
    console.error(`v3-ship-verify error: ${err && err.message ? err.message : err}`)
    process.exitCode = 2
  } finally {
    objectStore?.close?.()
    if (server?.child?.pid) { try { process.kill(-server.child.pid, 'SIGTERM') } catch { server.child.kill('SIGKILL') } }
  }
  process.exit(process.exitCode ?? 2)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
