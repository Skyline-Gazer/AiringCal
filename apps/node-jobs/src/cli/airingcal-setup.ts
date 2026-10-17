import { readFileSync } from 'node:fs'
import {
  formatPortableEnvLines,
  loadAiringcalConfigFromFile,
  portableEnvFromAiringcalConfig,
  type AiringcalPlatform,
} from '@airing-cal/v3-adapters'

export const PORTABLE_SECRET_ENV_KEYS = [
  'BGM_TOKEN',
  'AIRINGCAL_USERS_JSON',
  'AIRINGCAL_PRIMARY_USER_ID',
] as const

/** Secrets/env an operator must supply per platform; the config file itself holds none of them. */
export const PLATFORM_SECRET_ENV_KEYS: Record<AiringcalPlatform, readonly string[]> = {
  portable: PORTABLE_SECRET_ENV_KEYS,
  cloudflare: [...PORTABLE_SECRET_ENV_KEYS, 'CLOUDFLARE_API_TOKEN'],
  edgeone: PORTABLE_SECRET_ENV_KEYS,
}

export interface AiringcalSetupResult {
  platform: AiringcalPlatform
  env_lines: string
  secrets_required: readonly string[]
  /** Non-secret bindings/resources the platform declares outside this config (e.g. wrangler.toml). */
  bindings_required: readonly string[]
}

/**
 * Non-interactive setup: validates the operator config (JSON or `airingcal.yaml`)
 * and reports the env an operator must provide. Secrets stay in the environment —
 * nothing secret is written to the emitted env lines.
 */
export function runAiringcalSetup(
  configPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AiringcalSetupResult {
  const config = loadAiringcalConfigFromFile(configPath, readFile)
  switch (config.platform) {
    case 'portable':
      return {
        platform: 'portable',
        env_lines: formatPortableEnvLines(portableEnvFromAiringcalConfig(config)),
        secrets_required: PLATFORM_SECRET_ENV_KEYS.portable,
        bindings_required: [],
      }
    case 'cloudflare':
      // The Cloudflare read worker declares its R2 binding in wrangler.toml; the
      // release is still built by the portable/Compose builder.
      return {
        platform: 'cloudflare',
        env_lines: formatPortableEnvLines({ AIRINGCAL_PLATFORM: 'cloudflare' }),
        secrets_required: PLATFORM_SECRET_ENV_KEYS.cloudflare,
        bindings_required: ['wrangler.toml: [[r2_buckets]] binding = "AIRINGCAL_PUBLIC_R2"'],
      }
    case 'edgeone':
      throw new Error('airingcal setup does not support platform edgeone yet; the EdgeOne adapter is a stub (#72)')
  }
}

if (process.argv[1]?.endsWith('airingcal-setup.ts')) {
  const configPath = process.argv[2]
  const emitEnv = process.argv.includes('--emit-env')
  try {
    if (!configPath) throw new Error('Usage: airingcal-setup.ts <airingcal.yaml|.json> [--emit-env]')
    const result = runAiringcalSetup(configPath)
    if (emitEnv) process.stdout.write(result.env_lines)
    console.log(JSON.stringify({
      status: 'ok',
      stage: 'airingcal_setup',
      platform: result.platform,
      secrets_required: result.secrets_required,
      bindings_required: result.bindings_required,
      emitted_env: emitEnv,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'setup_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'airingcal_setup', message }))
    process.exit(1)
  }
}
