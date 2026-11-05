export interface S3BucketConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export interface S3EnvKeys {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

export function readS3BucketConfig(
  env: Record<string, string | undefined>,
  keys: S3EnvKeys,
): S3BucketConfig | null {
  const endpoint = env[keys.endpoint]?.trim()
  const bucket = env[keys.bucket]?.trim()
  const accessKeyId = env[keys.accessKeyId]?.trim()
  const secretAccessKey = env[keys.secretAccessKey]?.trim()
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return {
    endpoint,
    region: env[keys.region]?.trim() || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey,
  }
}

const CHECKPOINT_KEYS: S3EnvKeys = {
  endpoint: 'AIRINGCAL_CHECKPOINT_S3_ENDPOINT',
  region: 'AIRINGCAL_CHECKPOINT_S3_REGION',
  bucket: 'AIRINGCAL_CHECKPOINT_S3_BUCKET',
  accessKeyId: 'AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID',
  secretAccessKey: 'AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY',
}

const PUBLIC_KEYS: S3EnvKeys = {
  endpoint: 'AIRINGCAL_PUBLIC_S3_ENDPOINT',
  region: 'AIRINGCAL_PUBLIC_S3_REGION',
  bucket: 'AIRINGCAL_PUBLIC_S3_BUCKET',
  accessKeyId: 'AIRINGCAL_PUBLIC_S3_ACCESS_KEY_ID',
  secretAccessKey: 'AIRINGCAL_PUBLIC_S3_SECRET_ACCESS_KEY',
}

export function readCheckpointS3Config(env: Record<string, string | undefined>): S3BucketConfig | null {
  return readS3BucketConfig(env, CHECKPOINT_KEYS)
}

export function readPublicS3Config(env: Record<string, string | undefined>): S3BucketConfig | null {
  return readS3BucketConfig(env, PUBLIC_KEYS)
}
