import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { emitPortableEnvFromConfigPath } from './airingcal-config-emit.ts'

test('emitPortableEnvFromConfigPath renders sorted env lines from docs example', () => {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  const out = emitPortableEnvFromConfigPath(join(repoRoot, 'docs/v3/airingcal-config.example.json'))
  assert.match(out, /^AIRINGCAL_BUILDER=portable/m)
  assert.match(out, /AIRINGCAL_BUILDER_SQLITE_PATH=\/data\/builder.sqlite/)
  assert.ok(out.indexOf('AIRINGCAL_BUILDER=') < out.indexOf('AIRINGCAL_PLATFORM='))
})
