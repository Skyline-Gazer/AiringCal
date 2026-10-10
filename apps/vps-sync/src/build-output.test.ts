import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))

test('the emitted upstream modules import with plain Node and share the error constructor', () => {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDirectory, stdio: 'pipe' })
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', 'const fetchModule = await import("./dist/upstream/fetch.js"); const retryModule = await import("./dist/upstream/retry.js"); const runModule = await import("./dist/run.js"); const runtimeModule = await import("./dist/runtime.js"); const sentryModule = await import("./dist/observability/sentry.js"); await import("./dist/media/refresh.js"); await import("./dist/postgres/repositories.js"); if (fetchModule.UpstreamFetchError !== retryModule.UpstreamFetchError) throw new Error("UPSTREAM_ERROR_IDENTITY_MISMATCH"); if (runModule.exitCode("partial") !== 1) throw new Error("RUN_IMPORT_FAILED"); if (typeof runtimeModule.runFromEnvironment !== "function") throw new Error("RUNTIME_IMPORT_FAILED"); if (typeof sentryModule.createNodeSentryTracing !== "function") throw new Error("SENTRY_ADAPTER_IMPORT_FAILED"); console.log("EMITTED_UPSTREAM_IMPORT_OK")'],
    { cwd: appDirectory, encoding: 'utf8', stdio: 'pipe' },
  )
  assert.match(output, /EMITTED_UPSTREAM_IMPORT_OK/)
})

test('the emitted runtime imports with only its production packages', () => {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDirectory, stdio: 'pipe' })
  const runtimeDirectory = mkdtempSync(join(tmpdir(), 'airing-cal-vps-runtime-'))
  try {
    cpSync(join(appDirectory, 'dist'), join(runtimeDirectory, 'dist'), { recursive: true })
    mkdirSync(join(runtimeDirectory, 'node_modules', '@aws-sdk'), { recursive: true })
    symlinkSync(join(appDirectory, 'node_modules', 'pg'), join(runtimeDirectory, 'node_modules', 'pg'))
    symlinkSync(join(appDirectory, 'node_modules', '@aws-sdk', 'client-s3'), join(runtimeDirectory, 'node_modules', '@aws-sdk', 'client-s3'))
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', 'const runtime = await import("./dist/runtime.js"); if (typeof runtime.runFromEnvironment !== "function") throw new Error("RUNTIME_IMPORT_FAILED"); console.log("RUNTIME_ONLY_IMPORT_OK")'],
      { cwd: runtimeDirectory, encoding: 'utf8', stdio: 'pipe' },
    )
    assert.match(output, /RUNTIME_ONLY_IMPORT_OK/)
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true })
  }
})

test('the emitted container entrypoint fails closed until the production CLI exists', () => {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDirectory, stdio: 'pipe' })
  assert.throws(
    () => execFileSync(process.execPath, ['dist/entrypoint.js'], { cwd: appDirectory, encoding: 'utf8', stdio: 'pipe' }),
    (error: { status?: number; stderr?: string }) => error.status === 1 && error.stderr?.includes('RUNTIME_ENTRYPOINT_UNCONFIGURED'),
  )
})
