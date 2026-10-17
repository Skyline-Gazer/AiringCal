import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAiringcalConfig, portableEnvFromAiringcalConfig } from './airingcal-config.ts'

test('parseAiringcalConfig accepts docs example', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
  const raw = readFileSync(join(repoRoot, 'docs/v3/airingcal-config.example.json'), 'utf8')
  const config = parseAiringcalConfig(JSON.parse(raw))
  assert.equal(config.platform, 'portable')
  const env = portableEnvFromAiringcalConfig(config)
  assert.equal(env.AIRINGCAL_BUILDER_SQLITE_PATH, '/data/builder.sqlite')
  assert.equal(env.AIRINGCAL_SCHEDULER_DAILY_AT, '03:00')
  assert.equal(env.AIRINGCAL_BUILDER_BACKUP_KEEP, '10')
})

test('parseAiringcalConfig rejects unknown schema', () => {
  assert.throws(() => parseAiringcalConfig({ schema_version: 2 }), /schema_version/)
})

test('parseAiringcalConfig validates portable scheduler daily_at_utc', () => {
  assert.throws(
    () => parseAiringcalConfig({
      schema_version: 1,
      platform: 'portable',
      scheduler: { daily_at_utc: '25:00' },
    }),
    /HH:MM/,
  )
})
