import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  ObjectStorePreconditionError,
  quoteEtag,
  type ConditionalObjectStore,
  type ObjectGet,
  type ObjectHead,
  type ObjectPutOptions,
} from './object-store.ts'
import type { S3BucketConfig } from './s3-env.ts'

function statusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

function isNotFound(error: unknown): boolean {
  const status = statusCode(error)
  if (status === 404) return true
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: string }).name)
    : ''
  return name === 'NotFound' || name === 'NoSuchKey'
}

export function createS3ObjectStore(config: S3BucketConfig): ConditionalObjectStore & { close(): void } {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 3,
  })

  return {
    async get(key: string): Promise<ObjectGet | null> {
      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }))
        if (!response.Body) return null
        const body = await response.Body.transformToByteArray()
        const etag = response.ETag ? quoteEtag(response.ETag) : quoteEtag('missing')
        return {
          body,
          etag,
          contentType: response.ContentType,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async head(key: string): Promise<ObjectHead | null> {
      try {
        const response = await client.send(new HeadObjectCommand({
          Bucket: config.bucket,
          Key: key,
        }))
        if (!response.ETag) return null
        return {
          etag: quoteEtag(response.ETag),
          contentType: response.ContentType,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async put(key: string, body: Uint8Array, options: ObjectPutOptions = {}): Promise<ObjectHead> {
      try {
        const response = await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ContentLength: body.byteLength,
          IfMatch: options.ifMatch,
          IfNoneMatch: options.ifNoneMatch,
        }))
        const etag = response.ETag ? quoteEtag(response.ETag) : quoteEtag('missing')
        return { etag, contentType: options.contentType }
      } catch (error) {
        const status = statusCode(error)
        if (status === 409 || status === 412) {
          throw new ObjectStorePreconditionError(`S3 precondition failed for ${key} (${status})`)
        }
        throw error
      }
    },

    async delete(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))
    },

    close() {
      client.destroy()
    },
  }
}
