import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { runAiringcalSetupPortable } from './airingcal-setup.ts'

test('runAiringcalSetupPortable maps docs example and lists secrets', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  const result = runAiringcalSetupPortable(join(repoRoot, 'docs/v3/airingcal-config.example.json'))
  assert.equal(result.platform, 'portable')
  assert.match(result.env_lines, /AIRINGCAL_BUILDER=portable/)
  assert.ok(result.secrets_required.includes('BGM_TOKEN'))
})
