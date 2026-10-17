/**

 * Non-production staging smoke for the v3 Cloudflare read gateway (#72).
 *
 * Publishes a real builder checkpoint to a temporary public dir, seeds a local
 * R2 emulation with `wrangler r2 object put --local`, starts `wrangler dev -l`,
 * and asserts the v2 read surface over HTTP. Never touches remote resources.
 *
 * Usage: pnpm exec tsx apps/v3-read-worker/scripts/staging-smoke.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { assembleFullFetch } from '@airing-cal/bgm-api'
import {
  openBuilderDatabase,
  publishBuilderCheckpoint,
  runBuilderSyncJob,
  SqliteBuilderStateStore,
  SyncRunStore,
} from '@airing-cal/v3-builder'
import { FilesystemPublicStore, PUBLIC_RELEASE_POINTER_KEY } from '@airing-cal/v3-core'
import { V2_CACHE_CONTROL } from '@airing-cal/v3-core/read-contract'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const CONFIG = 'apps/v3-read-worker/wrangler.toml'
const BUCKET = 'airing-cal-public'
const IMAGE_HASH = 'a'.repeat(64)
const BUILD_SHA = 'f'.repeat(40)
const PACKAGE_VERSION = '3.0.0-alpha.0'
const PORT = Number(process.env.V3_READ_SMOKE_PORT ?? 8799)
const BASE_URL = `http://127.0.0.1:${PORT}`

const workDir = mkdtempSync(join(tmpdir(), 'v3-read-smoke-'))
const stateDir = join(workDir, 'state')
const publicDir = join(workDir, 'public')

async function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

function log(stage: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ status: 'info', stage, ...extra }))
}

function wrangler(args: string[], stdio: 'inherit' | 'pipe' = 'pipe') {
  return spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: REPO_ROOT, encoding: 'utf8', stdio })
}

async function publishFixture(): Promise<void> {
  const publicStore = new FilesystemPublicStore(publicDir)
  const db = openBuilderDatabase(':memory:')
  try {
    const state = new SqliteBuilderStateStore(db)
    const runs = new SyncRunStore(db)
    await runBuilderSyncJob({
      state,
      runs,
      runId: 'smoke-run',
      mode: 'incremental',
      ownerToken: 'smoke',
      fetchInput: async () => assembleFullFetch(
        [{ user_id: '1', pageLimit: 50, pages: [{ offset: 0, total: 0, data: [] }] }],
        [{ weekday: { en: 'Mon', cn: '一', ja: '月', id: 1 }, items: [] }],
        1_700_000_000,
      ),
      now: () => 1_700_000_000_000,
    })
    const result = await publishBuilderCheckpoint({
      state,
      publicStore,
      manifestMetadata: { source_observed_at: '2026-01-01T00:00:00.000Z', git_sha: 'f'.repeat(40) },
    })
    if (result.status !== 'published') throw new Error(`fixture publish failed: ${result.status}`)
  } finally {
    db.close()
  }
  const pointer = JSON.parse(readFileSync(join(publicDir, PUBLIC_RELEASE_POINTER_KEY), 'utf8')) as { generation: number }
  log('fixture_published', { generation: pointer.generation, publicDir })
}

function listFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

async function stopWorker(child: ChildProcess): Promise<void> {
  const exited = Promise.withResolvers<void>()
  child.once('exit', () => exited.resolve())
  child.kill('SIGTERM')
  const stopped = await Promise.race([exited.promise.then(() => true), delay(5_000).then(() => false)])
  if (!stopped) {
    child.kill('SIGKILL')
    await exited.promise
  }
}

function seedBucket(): void {
  const configToml = readFileSync(join(REPO_ROOT, CONFIG), 'utf8')
  if (!configToml.includes(`bucket_name = "${BUCKET}"`)) {
    throw new Error(`${CONFIG} does not declare bucket_name = "${BUCKET}"; keep the smoke seed target in sync`)
  }
  const seedFile = join(workDir, 'seed-image.bin')
  writeFileSync(seedFile, 'smoke-image-bytes')
  const objects = [
    ...listFiles(publicDir).map((path) => ({ key: relative(publicDir, path).split(sep).join('/'), path })),
    { key: `images/${IMAGE_HASH}/original`, path: seedFile },
  ]
  for (const object of objects) {
    const result = wrangler([
      'r2', 'object', 'put', `${BUCKET}/${object.key}`,
      '--file', object.path,
      '--local', '--persist-to', stateDir,
      '--config', CONFIG,
    ])
    if (result.status !== 0) {
      throw new Error(`wrangler r2 object put failed for ${object.key}: ${result.stderr || result.stdout}`)
    }
  }
  log('bucket_seeded', { objects: objects.length })
}

async function waitForWorker(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early with ${child.exitCode}`)
    try {
      const response = await fetch(`${BASE_URL}/api/version`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await delay(500)
  }
  throw new Error('wrangler dev did not become ready within 60s')
}

async function assertResponse(
  path: string,
  expected: { status: number; cacheControl?: string; bodyIncludes?: string[]; contentType?: string },
): Promise<void> {
  const response = await fetch(`${BASE_URL}${path}`)
  const body = await response.text()
  if (response.status !== expected.status) {
    throw new Error(`${path}: expected ${expected.status}, got ${response.status} (${body.slice(0, 200)})`)
  }
  const cacheControl = response.headers.get('Cache-Control')
  if (expected.cacheControl !== undefined && cacheControl !== expected.cacheControl) {
    throw new Error(`${path}: expected Cache-Control ${expected.cacheControl}, got ${cacheControl}`)
  }
  const contentType = response.headers.get('Content-Type')
  if (expected.contentType !== undefined && contentType !== expected.contentType) {
    throw new Error(`${path}: expected Content-Type ${expected.contentType}, got ${contentType}`)
  }
  for (const fragment of expected.bodyIncludes ?? []) {
    if (!body.includes(fragment)) throw new Error(`${path}: body missing ${fragment}`)
  }
  log('checked', { path, status: response.status, cacheControl })
}

async function run(): Promise<void> {
  await publishFixture()
  seedBucket()

  const child = spawn(
    'pnpm',
    [
      'exec', 'wrangler', 'dev', '--config', CONFIG, '-l', '--port', String(PORT),
      '--persist-to', stateDir, '--log-level', 'warn',
      '--var', `BANGUMI_GIT_COMMIT_SHA:${BUILD_SHA}`,
      '--var', `PACKAGE_VERSION:${PACKAGE_VERSION}`,
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  )
  const devLog: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => devLog.push(chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => devLog.push(chunk.toString()))

  try {
    await waitForWorker(child)
    log('worker_ready', { baseUrl: BASE_URL })

    await assertResponse('/api/version', {
      status: 200,
      cacheControl: V2_CACHE_CONTROL.version,
      bodyIncludes: [`"platform":"cloudflare"`, `"package":"${PACKAGE_VERSION}"`],
    })
    await assertResponse('/api/health', { status: 200, bodyIncludes: ['"scheduler":"external"'] })
    await assertResponse('/api/collections?type=watching&page=1&limit=24', {
      status: 200,
      cacheControl: V2_CACHE_CONTROL.collections,
    })
    await assertResponse('/api/calendar', { status: 200, cacheControl: V2_CACHE_CONTROL.calendar })
    await assertResponse('/api/config?key=nsfw', { status: 200, cacheControl: V2_CACHE_CONTROL.config })
    await assertResponse(`/image/${IMAGE_HASH}`, {
      status: 200,
      cacheControl: V2_CACHE_CONTROL.image,
      bodyIncludes: ['smoke-image-bytes'],
    })
    await assertResponse('/', { status: 200, contentType: 'text/html; charset=utf-8', bodyIncludes: [`Build ${BUILD_SHA.slice(0, 7)}`] })
    await assertResponse('/api/sync/apply', { status: 410, cacheControl: V2_CACHE_CONTROL.error })

    console.log(JSON.stringify({
      status: 'ok',
      stage: 'v3_cf_read_smoke',
      checks: 8,
    }))
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      stage: 'v3_cf_read_smoke',
      message: error instanceof Error ? error.message : 'unknown',
      wranglerLog: devLog.join('').slice(-2000),
    }))
    process.exitCode = 1
  } finally {
    await stopWorker(child)
    if (statSync(workDir, { throwIfNoEntry: false })) rmSync(workDir, { recursive: true, force: true })
  }
}

await run()
