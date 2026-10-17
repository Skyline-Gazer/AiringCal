export type AiringcalPlatform = 'portable' | 'cloudflare' | 'edgeone'

export interface AiringcalConfigV1 {
  schema_version: 1
  platform: AiringcalPlatform
  builder?: {
    sqlite_path?: string
    public_dir?: string
    media_refresh?: 'skip' | 'refresh'
    publish?: boolean
  }
  read?: {
    public_dir?: string
    nsfw_show?: boolean
  }
  scheduler?: {
    daily_at_utc?: string
    full_every_days?: number
    backup_before_sync?: boolean
    backup_keep?: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePlatform(value: unknown): AiringcalPlatform {
  if (value === 'portable' || value === 'cloudflare' || value === 'edgeone') return value
  throw new Error('airingcal config platform must be portable, cloudflare, or edgeone')
}

export function parseAiringcalConfig(value: unknown): AiringcalConfigV1 {
  if (!isRecord(value) || value.schema_version !== 1) {
    throw new Error('airingcal config schema_version must be 1')
  }
  const platform = parsePlatform(value.platform)
  const builder = value.builder
  const read = value.read
  const scheduler = value.scheduler
  if (builder !== undefined && !isRecord(builder)) throw new Error('builder must be an object')
  if (read !== undefined && !isRecord(read)) throw new Error('read must be an object')
  if (scheduler !== undefined && !isRecord(scheduler)) throw new Error('scheduler must be an object')
  return {
    schema_version: 1,
    platform,
    builder: builder as AiringcalConfigV1['builder'],
    read: read as AiringcalConfigV1['read'],
    scheduler: scheduler as AiringcalConfigV1['scheduler'],
  }
}

/** Maps portable v1 config fields to existing AIRINGCAL_* env keys (partial; secrets still from env). */
export function portableEnvFromAiringcalConfig(config: AiringcalConfigV1): Record<string, string> {
  if (config.platform !== 'portable') {
    throw new Error('portableEnvFromAiringcalConfig requires platform portable')
  }
  const env: Record<string, string> = {
    AIRINGCAL_PLATFORM: 'portable',
    AIRINGCAL_BUILDER: 'portable',
  }
  const b = config.builder
  if (b?.sqlite_path) env.AIRINGCAL_BUILDER_SQLITE_PATH = b.sqlite_path
  if (b?.public_dir) {
    env.AIRINGCAL_BUILDER_PUBLIC_DIR = b.public_dir
    env.AIRINGCAL_PUBLIC_READ_DIR = config.read?.public_dir ?? b.public_dir
  }
  if (b?.media_refresh) env.AIRINGCAL_BUILDER_MEDIA_REFRESH = b.media_refresh
  if (b?.publish !== undefined) env.AIRINGCAL_BUILDER_PUBLISH = b.publish ? 'true' : 'false'
  if (config.read?.public_dir) env.AIRINGCAL_PUBLIC_READ_DIR = config.read.public_dir
  if (config.read?.nsfw_show !== undefined) env.NSFW_SHOW = config.read.nsfw_show ? 'true' : 'false'
  const s = config.scheduler
  if (s?.daily_at_utc) env.AIRINGCAL_SCHEDULER_DAILY_AT = s.daily_at_utc
  if (s?.full_every_days !== undefined) env.AIRINGCAL_SCHEDULER_FULL_EVERY_DAYS = String(s.full_every_days)
  if (s?.backup_before_sync !== undefined) {
    env.AIRINGCAL_SCHEDULER_BACKUP_BEFORE_SYNC = s.backup_before_sync ? 'true' : 'false'
  }
  if (s?.backup_keep !== undefined) env.AIRINGCAL_BUILDER_BACKUP_KEEP = String(s.backup_keep)
  return env
}
