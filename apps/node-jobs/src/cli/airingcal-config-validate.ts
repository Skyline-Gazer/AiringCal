import { readFileSync } from 'node:fs'
import { loadAiringcalConfigFromFile } from '@airing-cal/v3-adapters'

export function validateAiringcalConfigFile(configPath: string): { platform: string } {
  const config = loadAiringcalConfigFromFile(configPath, (p) => readFileSync(p, 'utf8'))
  return { platform: config.platform }
}

if (process.argv[1]?.endsWith('airingcal-config-validate.ts')) {
  const configPath = process.argv[2]
  try {
    if (!configPath) throw new Error('Usage: airingcal-config-validate.ts <airingcal.config.json>')
    const result = validateAiringcalConfigFile(configPath)
    console.log(JSON.stringify({ status: 'ok', stage: 'airingcal_config_validate', ...result }))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'validate_failed'
    console.error(JSON.stringify({ status: 'failed', stage: 'airingcal_config_validate', message }))
    process.exit(1)
  }
}
