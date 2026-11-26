import { createHash } from 'node:crypto'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
  type ObjectRewriteMetadata,
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

function isPreconditionFailed(error: unknown): boolean {
  const status = statusCode(error)
  if (status === 409 || status === 412) return true
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: string }).name)
    : ''
  return name === 'PreconditionFailed'
}

function isCopyUnsupported(error: unknown): boolean {
  const status = statusCode(error)
  if (status === 501 || status === 405) return true
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: string }).name)
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return (
    name === 'NotImplemented'
    || name === 'MethodNotAllowed'
    || /not\s*implemented/i.test(message)
    || /method\s*not\s*allowed/i.test(message)
  )
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function encodeCopySource(bucket: string, key: string): string {
  return `${encodeURIComponent(bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

export interface CreateS3ObjectStoreOptions {
  /** Test double / injected client; when set, `close()` must still be safe. */
  client?: Pick<InstanceType<typeof S3Client>, 'send' | 'destroy'>
}

export function createS3ObjectStore(
  config: S3BucketConfig,
  options: CreateS3ObjectStoreOptions = {},
): ConditionalObjectStore & { close(): void } {
  const ownsClient = !options.client
  const client = options.client ?? new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 3,
  })

  async function getObjectBytes(key: string): Promise<{ body: Uint8Array; etag: string; contentType?: string }> {
    const response = await client.send(new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
    }))
    if (!response.Body) {
      throw new Error(`S3 GetObject returned empty body for ${key}`)
    }
    const body = await response.Body.transformToByteArray()
    const etag = response.ETag ? quoteEtag(response.ETag) : quoteEtag('missing')
    return { body, etag, contentType: response.ContentType }
  }

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
          size: response.ContentLength,
        }
      } catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },

    async list(prefix: string): Promise<string[]> {
      const keys: string[] = []
      let token: string | undefined
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }))
        for (const object of response.Contents ?? []) {
          if (object.Key) keys.push(object.Key)
        }
        token = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (token)
      return keys.sort()
    },

    async put(key: string, body: Uint8Array, options: ObjectPutOptions = {}): Promise<ObjectHead> {
      try {
        const response = await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          CacheControl: options.cacheControl,
          ContentDisposition: options.contentDisposition,
          ContentLength: body.byteLength,
          IfMatch: options.ifMatch,
          IfNoneMatch: options.ifNoneMatch,
        }))
        const etag = response.ETag ? quoteEtag(response.ETag) : quoteEtag('missing')
        return { etag, contentType: options.contentType }
      } catch (error) {
        if (isPreconditionFailed(error)) {
          throw new ObjectStorePreconditionError(`S3 precondition failed for ${key} (${statusCode(error) ?? 'unknown'})`)
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

    async rewriteMetadata(key: string, meta: ObjectRewriteMetadata): Promise<ObjectHead> {
      const preserveUserMetadata = meta.preserveUserMetadata !== false
      const head = await client.send(new HeadObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }))
      if (!head.ETag) {
        throw new Error(`S3 HeadObject missing ETag for ${key}`)
      }

      const prior = await getObjectBytes(key)
      const priorHash = sha256Hex(prior.body)
      const mergedMetadata = preserveUserMetadata && head.Metadata
        ? { ...head.Metadata }
        : undefined

      let usedFallback = false
      try {
        await client.send(new CopyObjectCommand({
          Bucket: config.bucket,
          Key: key,
          CopySource: encodeCopySource(config.bucket, key),
          MetadataDirective: 'REPLACE',
          ContentType: meta.contentType,
          CacheControl: meta.cacheControl,
          ContentDisposition: meta.contentDisposition,
          CopySourceIfMatch: meta.expectedEtag,
          ...(mergedMetadata ? { Metadata: mergedMetadata } : {}),
        }))
      } catch (error) {
        if (isPreconditionFailed(error)) {
          throw new ObjectStorePreconditionError(
            `S3 CopyObject precondition failed for ${key} (${statusCode(error) ?? 'unknown'})`,
          )
        }
        if (!isCopyUnsupported(error)) throw error
        usedFallback = true
        try {
          await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: prior.body,
            ContentType: meta.contentType,
            CacheControl: meta.cacheControl,
            ContentDisposition: meta.contentDisposition,
            ContentLength: prior.body.byteLength,
            IfMatch: meta.expectedEtag,
            ...(mergedMetadata ? { Metadata: mergedMetadata } : {}),
          }))
        } catch (putError) {
          if (isPreconditionFailed(putError)) {
            throw new ObjectStorePreconditionError(
              `S3 PutObject precondition failed for ${key} (${statusCode(putError) ?? 'unknown'})`,
            )
          }
          throw putError
        }
      }

      const verified = await getObjectBytes(key)
      const verifiedHash = sha256Hex(verified.body)
      if (verifiedHash !== priorHash) {
        throw new Error(
          `rewriteMetadata changed body bytes for ${key}`
            + ` (sha256 ${priorHash} → ${verifiedHash}`
            + `${usedFallback ? '; via Get+Put fallback' : ''})`,
        )
      }
      if (verified.contentType !== meta.contentType) {
        throw new Error(
          `rewriteMetadata Content-Type mismatch for ${key}:`
            + ` expected ${meta.contentType}, got ${verified.contentType ?? 'undefined'}`,
        )
      }
      return {
        etag: verified.etag,
        contentType: verified.contentType,
        size: verified.body.byteLength,
      }
    },

    close() {
      if (ownsClient) client.destroy()
    },
  }
}
