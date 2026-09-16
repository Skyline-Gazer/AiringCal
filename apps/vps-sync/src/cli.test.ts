import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RunRequest, RunResult } from './contracts.js'

type CliApi = {
  runOnceWithBackup(deps: Record<string, unknown>, request: RunRequest): Promise<RunResult>
}

async function cliApi(): Promise<CliApi> {
  try {
    return await import('./cli.js') as unknown as CliApi
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('injectable runOnce backup composition is not implemented')
    }
    throw error
  }
}

const request: RunRequest = { mode: 'live', source: 'manual' }
const databaseUrl = 'postgresql://backup-user:backup-password@db.example.test:5432/bangumi?sslmode=require'
const gitSha = 'b'.repeat(40)
const dump = Buffer.from('test custom-format dump')

function runDependencies(events: string[], publication: { status: string; generation?: number; contentHash?: string }) {
  return {
    runId: 'run-1',
    gitSha,
    now: () => Date.parse('2026-09-15T03:04:05.006Z'),
    lock: {
      acquire: async () => { events.push('lock'); return true },
      release: async () => { events.push('unlock') },
    },
    authority: {
      beginRun: async () => { events.push('begin') },
      heartbeat: async () => {},
      commitCompleteState: async () => {},
      finishRun: async () => { events.push('finish') },
    },
    fetchComplete: async () => ({
      run_id: 'run-1', observed_at: 1_789_449_600, complete: true,
      configured_user_ids: ['u'],
      users: [{ user_id: 'u', upstream_username: 'alice', complete: true, items: [] }],
      subjects: [], calendar: [],
    }),
    media: async () => ({ selected: 0, succeeded: 0, failed: 0 }),
    publish: async () => publication,
    notify: async (result: RunResult) => { events.push(`notify:${result.status}`) },
    close: async () => { events.push('close') },
  }
}

function storage(events: string[]) {
  const keys: string[] = []
  return {
    keys,
    port: {
      put: async (key: string) => { keys.push(key); events.push(`put:${key}`) },
      putStream: async (key: string, body: AsyncIterable<Uint8Array>) => {
        for await (const _chunk of body) { /* consume the stream as the storage adapter would */ }
        keys.push(key)
        events.push(`putStream:${key}`)
      },
    },
  }
}

test('requires an actual notifier before starting runOnce', async () => {
  const { runOnceWithBackup } = await cliApi()
  const events: string[] = []
  const dependencies = runDependencies(events, { status: 'published', generation: 1, contentHash: 'a'.repeat(64) })
  const { port } = storage(events)
  const tempRoot = await mkdtemp(join(tmpdir(), 'vps-sync-cli-test-'))

  try {
    const missingNotifier = {
      ...dependencies,
      notify: undefined,
      backupConfig: { databaseUrl, storage: port, tempRoot },
    }
    await assert.rejects(
      () => runOnceWithBackup(missingNotifier, request),
      /NOTIFIER_REQUIRED/,
    )
    assert.deepEqual(events, [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('wires createBackup after published and no_change, preserves publication on backup failure, and never backs up failed publication', async () => {
  const { runOnceWithBackup } = await cliApi()
  const tempRoot = await mkdtemp(join(tmpdir(), 'vps-sync-cli-test-'))

  try {
    for (const status of ['published', 'no_change'] as const) {
      const events: string[] = []
      const { port, keys } = storage(events)
      const publication = { status, generation: 2, contentHash: 'c'.repeat(64) }
      const deps = {
        ...runDependencies(events, publication),
        backupConfig: {
          databaseUrl,
          storage: port,
          tempRoot,
          runCommand: async (_command: string, args: readonly string[]) => {
            const output = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
            assert.ok(output)
            await writeFile(output, dump)
          },
        },
      }

      const result = await runOnceWithBackup(deps, request)
      assert.equal(result.status, status === 'published' ? 'success' : 'no_change')
      assert.deepEqual(result.publication, publication)
      assert.equal(result.components.backup, 'success')
      assert.equal(keys.length, 2)
      assert.ok(keys.some((key) => key.endsWith('.dump')))
      assert.ok(keys.some((key) => key.endsWith('.json')))
      assert.ok(events.some((event) => event === `notify:${result.status}`))
    }

    const failedEvents: string[] = []
    const failedStorage = storage(failedEvents)
    const failedPublication = { status: 'published', generation: 3, contentHash: 'd'.repeat(64) }
    const backupFailed = await runOnceWithBackup({
      ...runDependencies(failedEvents, failedPublication),
      backupConfig: {
        databaseUrl,
        storage: failedStorage.port,
        tempRoot,
        runCommand: async () => { throw new Error('dump failed') },
      },
    }, request)
    assert.equal(backupFailed.status, 'partial')
    assert.deepEqual(backupFailed.publication, failedPublication)
    assert.equal(backupFailed.components.publication, 'success')
    assert.equal(backupFailed.components.backup, 'failed')
    assert.deepEqual(failedStorage.keys, [])
    assert.ok(failedEvents.includes('notify:partial'))

    const skippedEvents: string[] = []
    const skippedStorage = storage(skippedEvents)
    const failed = await runOnceWithBackup({
      ...runDependencies(skippedEvents, { status: 'failed' }),
      backupConfig: { databaseUrl, storage: skippedStorage.port, tempRoot },
    }, request)
    assert.equal(failed.status, 'failed')
    assert.deepEqual(skippedStorage.keys, [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
