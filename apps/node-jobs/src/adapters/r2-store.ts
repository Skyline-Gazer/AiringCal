import { createHash } from 'node:crypto'
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { NodeJobsConfig } from './env.ts'
import { fail } from './errors.ts'
import type { RunContext } from './run-context.ts'

export interface R2ObjectRead {
  bytes: Uint8Array
  etag?: string
}

export interface R2Store {
  put(key: string, body: Uint8Array, contentType?: string, condition?: { absent?: boolean; etag?: string }): Promise<void>
  get(key: string, maximumBytes?: number): Promise<Uint8Array | null>
  verifiedPut(key: string, bytes: Uint8Array, contentType?: string): Promise<void>
  close(): void
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createR2Store(config: NodeJobsConfig, run: RunContext, timeoutMs = 20_000): R2Store {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.cloudflareAccountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.r2AccessKeyId, secretAccessKey: config.r2SecretAccessKey },
    maxAttempts: 3,
  })

  async function send(command: PutObjectCommand | GetObjectCommand) {
    run.guard(timeoutMs + 1000)
    return client.send(command, {
      abortSignal: AbortSignal.any([run.signal, AbortSignal.timeout(timeoutMs)]),
    })
  }

  async function readObject(key: string, maximumBytes: number): Promise<R2ObjectRead | null> {
    let response
    try {
      response = await send(new GetObjectCommand({ Bucket: config.r2Bucket, Key: key }))
    } catch (error) {
      const status = typeof error === 'object' && error !== null && '$metadata' in error
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined
      if (status === 404) return null
      fail('R2_READ_FAILED', status, { cause: error })
    }
    if (!response.Body || (response.ContentLength !== undefined && response.ContentLength > maximumBytes)) {
      response.Body?.destroy()
      fail('R2_READ_FAILED')
    }
    const bytes = await response.Body.transformToByteArray()
    if (bytes.byteLength > maximumBytes) fail('R2_READ_FAILED')
    return { bytes, etag: response.ETag }
  }

  return {
    async put(key, body, contentType = 'application/json', condition = {}) {
      try {
        await send(new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
          IfNoneMatch: condition.absent ? '*' : undefined,
          IfMatch: condition.etag,
          CacheControl: key.startsWith('backups/') ? 'private, no-store' : key.startsWith('public/') ? 'no-store' : 'public, max-age=31536000, immutable',
        }))
      } catch (error) {
        const status = typeof error === 'object' && error !== null && '$metadata' in error
          ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
          : undefined
        if (status === 409 || status === 412) fail('R2_PRECONDITION_FAILED', status, { cause: error })
        fail('R2_WRITE_FAILED', status, { cause: error })
      }
    },
    async get(key, maximumBytes = 32 * 1024 * 1024) {
      const object = await readObject(key, maximumBytes)
      return object?.bytes ?? null
    },
    async verifiedPut(key, bytes, contentType = 'application/json') {
      await this.put(key, bytes, contentType)
      const copy = await this.get(key, bytes.byteLength)
      if (!copy || sha256(copy) !== sha256(bytes)) fail('R2_READBACK_MISMATCH')
    },
    close: () => client.destroy(),
  }
}
