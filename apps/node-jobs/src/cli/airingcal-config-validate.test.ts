import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateAiringcalConfigFile } from './airingcal-config-validate.ts'

test('validateAiringcalConfigFile accepts docs example', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  const result = validateAiringcalConfigFile(join(repoRoot, 'docs/v3/airingcal-config.example.json'))
  assert.equal(result.platform, 'portable')
})
