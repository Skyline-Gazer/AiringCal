import { fail } from './errors.ts'

const ACCOUNT_ID = /^[0-9a-f]{32}$/
const D1_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const R2_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

export interface NodeJobsConfig {
  cloudflareAccountId: string
  d1DatabaseId: string
  cloudflareApiToken: string
  r2Bucket: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  kvNamespaceId?: string
}

function required(env: Record<string, string | undefined>, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value) return value
  }
  fail('CONFIG_INVALID')
}

export function readNodeJobsConfig(env: Record<string, string | undefined> = process.env): NodeJobsConfig {
  const cloudflareAccountId = required(env, 'CLOUDFLARE_ACCOUNT_ID')
  const d1DatabaseId = required(env, 'AIRING_CAL_D1_DATABASE_ID', 'AIRINGCAL_D1_DATABASE_ID')
  const cloudflareApiToken = required(env, 'CLOUDFLARE_API_TOKEN')
  const r2Bucket = required(env, 'AIRING_CAL_R2_BUCKET', 'AIRINGCAL_R2_BUCKET')
  const r2AccessKeyId = required(env, 'R2_ACCESS_KEY_ID')
  const r2SecretAccessKey = required(env, 'R2_SECRET_ACCESS_KEY')
  const kvRaw = env.AIRING_CAL_KV_NAMESPACE_ID?.trim() || env.AIRINGCAL_KV_NAMESPACE_ID?.trim()
  const kvNamespaceId = kvRaw || undefined
  if (!ACCOUNT_ID.test(cloudflareAccountId) || !D1_UUID.test(d1DatabaseId) || !R2_BUCKET.test(r2Bucket)) {
    fail('CONFIG_INVALID')
  }
  if (kvNamespaceId && !D1_UUID.test(kvNamespaceId)) fail('CONFIG_INVALID')
  return {
    cloudflareAccountId,
    d1DatabaseId,
    cloudflareApiToken,
    r2Bucket,
    r2AccessKeyId,
    r2SecretAccessKey,
    kvNamespaceId,
  }
}
