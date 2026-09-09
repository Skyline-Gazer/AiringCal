import { Pool } from 'pg'
import type { RunDependencies, RunRequest, RunResult } from './contracts.ts'
import { runOnce } from './run.ts'
import { PostgresAuthority } from './postgres/repositories.ts'
import { publishSnapshot, type SnapshotPublicationCandidate } from './publication/publish.ts'
import { createS3Port, type S3Port, type S3PortOptions } from './publication/s3.ts'

type RuntimeEnvironment = Record<string, string | undefined>

export type RuntimeConfig = {
  databaseUrl: string
  s3: S3PortOptions
  forbiddenValues: readonly string[]
}

export type RuntimeInput = Omit<RunDependencies, 'authority' | 'lock' | 'publish' | 'close'> & {
  request: RunRequest
  publicationCandidate(context: Parameters<RunDependencies['publish']>[0]): Promise<SnapshotPublicationCandidate>
}

export type RuntimeIo = {
  createPool(databaseUrl: string): Pool
  createS3Port(options: S3PortOptions): S3Port
  runOnce(deps: RunDependencies, request: RunRequest): Promise<RunResult>
}

const productionIo: RuntimeIo = {
  createPool: (databaseUrl) => new Pool({ connectionString: databaseUrl }),
  createS3Port,
  runOnce,
}

export function readRuntimeConfig(environment: RuntimeEnvironment): RuntimeConfig {
  const required = (name: keyof RuntimeEnvironment): string => {
    const value = environment[name]
    if (!value?.trim()) throw new Error(`RUNTIME_CONFIG_REQUIRED:${name}`)
    return value
  }
  const databaseUrl = required('DATABASE_URL')
  const accessKeyId = required('R2_ACCESS_KEY_ID')
  const secretAccessKey = required('R2_SECRET_ACCESS_KEY')
  return {
    databaseUrl,
    s3: {
      endpoint: required('R2_ENDPOINT'), bucket: required('R2_BUCKET'), region: required('R2_REGION'),
      accessKeyId, secretAccessKey,
    },
    forbiddenValues: [databaseUrl, accessKeyId, secretAccessKey],
  }
}

/** The single VPS composition boundary; operational I/O remains injected by its caller. */
export async function runFromEnvironment(
  input: RuntimeInput,
  environment: RuntimeEnvironment = process.env,
  io: RuntimeIo = productionIo,
): Promise<RunResult> {
  const config = readRuntimeConfig(environment)
  const pool = io.createPool(config.databaseUrl)
  const authority = new PostgresAuthority(pool, { forbiddenValues: config.forbiddenValues })
  const s3 = io.createS3Port(config.s3)
  return io.runOnce({
    ...input,
    authority,
    lock: authority.businessLock(),
    publish: async (context) => {
      const outcome = await publishSnapshot(
        { now: () => new Date(input.now()).toISOString(), s3, publication: authority.publicationPort() },
        await input.publicationCandidate(context),
        context.mode,
      )
      if (outcome === 'pending') throw new Error('PUBLICATION_PENDING')
      const state = await authority.publicationPort().forMode(context.mode).getState()
      if (state.verifiedContentHash === null) throw new Error('PUBLICATION_PENDING')
      return { status: outcome, generation: state.verifiedGeneration, contentHash: state.verifiedContentHash }
    },
    close: pool.end,
  }, input.request)
}
