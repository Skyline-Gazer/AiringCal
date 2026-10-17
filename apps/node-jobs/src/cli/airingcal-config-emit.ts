import { readFileSync } from 'node:fs'
import {
  formatPortableEnvLines,
  loadAiringcalConfigFromFile,
  portableEnvFromAiringcalConfig,
} from '@airing-cal/v3-adapters'

export function emitPortableEnvFromConfigPath(configPath: string): string {
  const config = loadAiringcalConfigFromFile(configPath, (p) => readFileSync(p, 'utf8'))
  const env = portableEnvFromAiringcalConfig(config)
  return formatPortableEnvLines(env)
}

if (process.argv[1]?.endsWith('airingcal-config-emit.ts')) {
  const configPath = process.argv[2]
  try {
    if (!configPath) throw new Error('Usage: airingcal-config-emit.ts <airingcal.yaml|.json>')
    process.stdout.write(emitPortableEnvFromConfigPath(configPath))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'config_emit_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'airingcal_config_emit', message }))
    process.exit(1)
  }
}
