import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export interface S3Port {
  put(key: string, bytes: Uint8Array, options?: { ifNoneMatch?: '*' }): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
}

export interface R2Config {
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const response = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return response.name === 'NoSuchKey' || response.name === 'NotFound' || response.$metadata?.httpStatusCode === 404
}

function isConditionalWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const response = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return response.name === 'PreconditionFailed'
    || response.name === 'ConditionalRequestConflict'
    || response.$metadata?.httpStatusCode === 409
    || response.$metadata?.httpStatusCode === 412
}

export function createS3Port(config: R2Config, client = new S3Client({
  region: 'auto',
  endpoint: config.endpoint,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
})): S3Port {
  return {
    async put(key, bytes, options) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/json',
          IfNoneMatch: options?.ifNoneMatch,
        }))
      } catch (error) {
        if (options?.ifNoneMatch === '*' && isConditionalWriteConflict(error)) return
        throw error
      }
    },

    async get(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        return response.Body ? new Uint8Array(await response.Body.transformToByteArray()) : new Uint8Array()
      } catch (error) {
        if (isMissingObject(error)) return null
        throw error
      }
    },

    async list(prefix) {
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const response = await client.send(new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }))
        for (const object of response.Contents ?? []) {
          if (object.Key !== undefined) keys.push(object.Key)
        }
        if (!response.IsTruncated) break
        if (!response.NextContinuationToken || response.NextContinuationToken === continuationToken) {
          throw new Error('R2 list did not return a next continuation token')
        }
        continuationToken = response.NextContinuationToken
      } while (true)
      return keys
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    },
  }
}
