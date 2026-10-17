import { readFileSync } from 'node:fs'
import {
  formatPortableEnvLines,
  loadAiringcalConfigFromFile,
  portableEnvFromAiringcalConfig,
} from '@airing-cal/v3-adapters'

export const PORTABLE_SECRET_ENV_KEYS = [
  'BGM_TOKEN',
  'AIRINGCAL_USERS_JSON',
  'AIRINGCAL_PRIMARY_USER_ID',
] as const

export function runAiringcalSetupPortable(configPath: string): {
  platform: 'portable'
  env_lines: string
  secrets_required: readonly string[]
} {
  const config = loadAiringcalConfigFromFile(configPath, (p) => readFileSync(p, 'utf8'))
  if (config.platform !== 'portable') {
    throw new Error(`airingcal setup supports portable only in this slice (got ${config.platform})`)
  }
  const env = portableEnvFromAiringcalConfig(config)
  return {
    platform: 'portable',
    env_lines: formatPortableEnvLines(env),
    secrets_required: PORTABLE_SECRET_ENV_KEYS,
  }
}

if (process.argv[1]?.endsWith('airingcal-setup.ts')) {
  const configPath = process.argv[2]
  const emitEnv = process.argv.includes('--emit-env')
  try {
    if (!configPath) throw new Error('Usage: airingcal-setup.ts <airingcal.config.json> [--emit-env]')
    const result = runAiringcalSetupPortable(configPath)
    if (emitEnv) process.stdout.write(result.env_lines)
    console.log(JSON.stringify({
      status: 'ok',
      stage: 'airingcal_setup',
      platform: result.platform,
      secrets_required: result.secrets_required,
      emitted_env: emitEnv,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'setup_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'airingcal_setup', message }))
    process.exit(1)
  }
}
