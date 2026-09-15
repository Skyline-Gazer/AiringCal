import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { canonicalJson } from '@airing-cal/storage'
import { createS3Port } from '../publication/s3.js'
import { createBackup } from './backup.js'

const gitSha = 'b'.repeat(40)
const databaseUrl = 'postgresql://backup-user:backup-password@db.example.test:5432/bangumi?sslmode=require'
const createdAt = '2026-09-15T03:04:05.006Z'
const dumpBytes = Buffer.from('fake custom-format PostgreSQL archive')

function s3Port(options: { failAt?: number } = {}, events: string[] = []) {
  const uploads: { key: string; body: Uint8Array; size?: number; contentType?: string }[] = []
  let attempts = 0
  const client = {
    async send(command: PutObjectCommand) {
      assert.ok(command instanceof PutObjectCommand)
      attempts += 1
      events.push(`put:${command.input.Key}`)
      const body = command.input.Body
      assert.ok(body)
      const chunks: Buffer[] = []
      if (body instanceof Readable) {
        for await (const chunk of body) chunks.push(Buffer.from(chunk))
      } else {
        chunks.push(Buffer.from(body as Uint8Array))
      }
      uploads.push({
        key: command.input.Key ?? '',
        body: Buffer.concat(chunks),
        size: command.input.ContentLength,
        contentType: command.input.ContentType,
      })
      if (attempts === options.failAt) throw new Error('R2 upload failed')
      return {}
    },
  }
  return {
    uploads,
    port: createS3Port({
      bucket: 'backup-test',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
    }, client as unknown as S3Client),
  }
}

test('dumps custom format, hashes and streams it before uploading a canonical manifest', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'airing-cal-backup-test-'))
  const inheritedPostgresEnv = {
    PGHOST: 'wrong-host',
    PGDATABASE: 'wrong-database',
    PGUSER: 'wrong-user',
    PGPASSWORD: 'wrong-password',
    PGSSLMODE: 'disable',
    PGSERVICE: 'wrong-service',
    PGSERVICEFILE: '/wrong/service.conf',
  }
  const previousPostgresEnv = Object.fromEntries(
    Object.keys(inheritedPostgresEnv).map((key) => [key, process.env[key]]),
  )
  Object.assign(process.env, inheritedPostgresEnv)
  const events: string[] = []
  const commandCalls: {
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
    serviceConfig: string
    serviceFileMode: number
  }[] = []
  const { port, uploads } = s3Port({}, events)
  const runCommand = async (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    events.push('dump')
    const serviceFile = options.env.PGSERVICEFILE
    assert.ok(serviceFile)
    commandCalls.push({
      command,
      args: [...args],
      env: options.env,
      serviceConfig: await readFile(serviceFile, 'utf8'),
      serviceFileMode: (await stat(serviceFile)).mode & 0o777,
    })
    const output = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
    assert.ok(output)
    await writeFile(output, dumpBytes)
  }

  try {
    const result = await createBackup({
      databaseUrl,
      storage: port,
      now: () => Date.parse(createdAt),
      tempRoot,
      runCommand,
    }, { runId: 'run-1', gitSha })

    const prefix = 'backups/postgres/2026/09/15/20260915T030405006Z-' + gitSha
    const dumpKey = `${prefix}.dump`
    const manifestKey = `${prefix}.json`
    const sha256 = createHash('sha256').update(dumpBytes).digest('hex')
    assert.deepEqual(result, { dumpKey, manifestKey, size: dumpBytes.length, sha256 })
    assert.deepEqual(events, ['dump', `put:${dumpKey}`, `put:${manifestKey}`])
    assert.equal(commandCalls[0]?.command, 'pg_dump')
    assert.equal(commandCalls[0]?.args[0], '--format=custom')
    assert.ok(commandCalls[0]?.args[1]?.startsWith('--file='))
    assert.ok(commandCalls[0]?.args[1]?.slice('--file='.length).startsWith(`${tempRoot}/`))
    assert.equal(commandCalls[0]?.env.PGDATABASE, undefined)
    assert.equal(commandCalls[0]?.env.PGHOST, undefined)
    assert.equal(commandCalls[0]?.env.PGUSER, undefined)
    assert.equal(commandCalls[0]?.env.PGPASSWORD, undefined)
    assert.equal(commandCalls[0]?.env.PGSSLMODE, undefined)
    assert.equal(commandCalls[0]?.env.PGSERVICE, 'airing-cal-backup')
    const serviceFile = commandCalls[0]?.env.PGSERVICEFILE ?? ''
    assert.ok(serviceFile.startsWith(`${tempRoot}/`))
    assert.equal(commandCalls[0]?.serviceConfig, [
      '[airing-cal-backup]',
      'user=backup-user',
      'password=backup-password',
      'host=db.example.test',
      'port=5432',
      'dbname=bangumi',
      'sslmode=require',
      '',
    ].join('\n'))
    assert.equal(commandCalls[0]?.serviceFileMode, 0o600)
    assert.equal(commandCalls[0]?.env.DATABASE_URL, undefined)
    assert.equal(commandCalls[0]?.args.some((arg) => arg.includes(databaseUrl)), false)
    assert.equal(commandCalls[0]?.serviceConfig.includes(databaseUrl), false)
    assert.equal(uploads[0]?.key, dumpKey)
    assert.deepEqual(uploads[0]?.body, dumpBytes)
    assert.equal(uploads[0]?.size, dumpBytes.length)
    assert.equal(uploads[0]?.contentType, 'application/octet-stream')
    assert.equal(uploads[1]?.key, manifestKey)
    assert.deepEqual(uploads[1]?.body, Buffer.from(canonicalJson({
      schema_version: 1,
      run_id: 'run-1',
      git_sha: gitSha,
      created_at: createdAt,
      object_key: dumpKey,
      size: dumpBytes.length,
      sha256,
    })))
    assert.equal(uploads[1]?.contentType, 'application/json')
    assert.deepEqual(await readdir(tempRoot), [])
  } finally {
    for (const [key, value] of Object.entries(previousPostgresEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('rejects an empty database URL or invalid git SHA before spawning or uploading', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'airing-cal-backup-test-'))
  const { port, uploads } = s3Port()
  let commandCalls = 0
  const runCommand = async () => { commandCalls += 1 }

  try {
    await assert.rejects(() => createBackup({
      databaseUrl: undefined as unknown as string,
      storage: port,
      tempRoot,
      runCommand,
    }, { runId: 'run-1', gitSha }), /BACKUP_FAILED/)
    await assert.rejects(() => createBackup({
      databaseUrl: '',
      storage: port,
      tempRoot,
      runCommand,
    }, { runId: 'run-1', gitSha }), /BACKUP_FAILED/)
    await assert.rejects(() => createBackup({
      databaseUrl,
      storage: port,
      tempRoot,
      runCommand,
    }, { runId: 'run-1', gitSha: 'B'.repeat(40) }), /BACKUP_FAILED/)
    assert.equal(commandCalls, 0)
    assert.deepEqual(uploads, [])
    assert.deepEqual(await readdir(tempRoot), [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('command failure skips uploads and always removes the temporary dump directory', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'airing-cal-backup-test-'))
  const { port, uploads } = s3Port()
  try {
    await assert.rejects(() => createBackup({
      databaseUrl,
      storage: port,
      now: () => Date.parse(createdAt),
      tempRoot,
      runCommand: async () => { throw new Error(`failed for ${databaseUrl}`) },
    }, { runId: 'run-1', gitSha }), /BACKUP_FAILED/)
    assert.deepEqual(uploads, [])
    assert.deepEqual(await readdir(tempRoot), [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

test('upload failure prevents the manifest upload and always removes the temporary dump directory', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'airing-cal-backup-test-'))
  const { port, uploads } = s3Port({ failAt: 1 })
  const runCommand = async (_command: string, args: readonly string[]) => {
    const output = args.find((arg) => arg.startsWith('--file='))?.slice('--file='.length)
    assert.ok(output)
    await writeFile(output, dumpBytes)
  }

  try {
    await assert.rejects(() => createBackup({
      databaseUrl,
      storage: port,
      now: () => Date.parse(createdAt),
      tempRoot,
      runCommand,
    }, { runId: 'run-1', gitSha }), /BACKUP_FAILED/)
    assert.equal(uploads.length, 1)
    assert.deepEqual(await readdir(tempRoot), [])
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})
