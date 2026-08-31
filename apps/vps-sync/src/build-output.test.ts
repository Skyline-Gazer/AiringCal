import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const appDirectory = fileURLToPath(new URL('..', import.meta.url))

test('the emitted upstream modules import with plain Node and share the error constructor', () => {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDirectory, stdio: 'pipe' })
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', 'const fetchModule = await import("./dist/upstream/fetch.js"); const retryModule = await import("./dist/upstream/retry.js"); const runModule = await import("./dist/run.js"); await import("./dist/media/refresh.js"); await import("./dist/postgres/repositories.js"); if (fetchModule.UpstreamFetchError !== retryModule.UpstreamFetchError) throw new Error("UPSTREAM_ERROR_IDENTITY_MISMATCH"); if (runModule.exitCode("partial") !== 1) throw new Error("RUN_IMPORT_FAILED"); console.log("EMITTED_UPSTREAM_IMPORT_OK")'],
    { cwd: appDirectory, encoding: 'utf8', stdio: 'pipe' },
  )
  assert.match(output, /EMITTED_UPSTREAM_IMPORT_OK/)
})
