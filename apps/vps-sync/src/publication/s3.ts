import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

export type S3Port = {
  put(key: string, bytes: Uint8Array, options?: { ifNoneMatch?: boolean }): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
}

export type S3PortOptions = {
  bucket: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** S3-compatible adapter; R2 uses the supplied endpoint and path-style bucket addressing. */
export function createS3Port(options: S3PortOptions): S3Port {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: true,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
  })
  return {
    put: async (key, bytes, putOptions) => {
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: bytes,
        ...(putOptions?.ifNoneMatch ? { IfNoneMatch: '*' } : {}) }))
    },
    get: async (key) => {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }))
        return result.Body ? await result.Body.transformToByteArray() : null
      } catch (error) {
        if (typeof error === 'object' && error !== null && '$metadata' in error
          && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
        throw error
      }
    },
    list: async (prefix) => {
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const result = await client.send(new ListObjectsV2Command({ Bucket: options.bucket, Prefix: prefix,
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }))
        keys.push(...(result.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []))
        continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
      } while (continuationToken)
      return keys
    },
    delete: async (key) => { await client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key })) },
  }
}
