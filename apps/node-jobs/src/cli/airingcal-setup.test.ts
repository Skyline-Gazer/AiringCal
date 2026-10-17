import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { PLATFORM_SECRET_ENV_KEYS, runAiringcalSetup } from './airingcal-setup.ts'

function docsPath(file: string): string {
  const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
  return join(repoRoot, 'docs/v3', file)
}

function tempConfig(name: string, content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'airingcal-setup-')), name)
  writeFileSync(path, content)
  return path
}

test('setup maps the portable JSON example and lists secrets', () => {
  const result = runAiringcalSetup(docsPath('airingcal-config.example.json'))
  assert.equal(result.platform, 'portable')
  assert.match(result.env_lines, /AIRINGCAL_BUILDER=portable/)
  assert.match(result.env_lines, /AIRINGCAL_BUILDER_SQLITE_PATH=\/data\/builder.sqlite/)
  assert.ok(result.secrets_required.includes('BGM_TOKEN'))
  assert.deepEqual(result.bindings_required, [])
})

test('setup reads airingcal.yaml and matches the JSON example exactly', () => {
  const fromYaml = runAiringcalSetup(docsPath('airingcal-config.example.yaml'))
  const fromJson = runAiringcalSetup(docsPath('airingcal-config.example.json'))
  assert.deepEqual(fromYaml, fromJson, 'both documented example formats must resolve identically')
})

test('setup reports Cloudflare bindings and token secret without emitting secrets', () => {
  const configPath = tempConfig('airingcal.yaml', [
    'schema_version: 1',
    'platform: cloudflare',
    '',
  ].join('\n'))
  const result = runAiringcalSetup(configPath)
  assert.equal(result.platform, 'cloudflare')
  assert.deepEqual(result.env_lines, 'AIRINGCAL_PLATFORM=cloudflare\n')
  assert.ok(result.secrets_required.includes('CLOUDFLARE_API_TOKEN'))
  assert.ok(result.bindings_required.some((entry) => entry.includes('AIRINGCAL_PUBLIC_R2')))
  assert.doesNotMatch(result.env_lines, /TOKEN|SECRET/, 'no secret may appear in the emitted env')
  assert.deepEqual(PLATFORM_SECRET_ENV_KEYS.cloudflare, [
    'BGM_TOKEN',
    'AIRINGCAL_USERS_JSON',
    'AIRINGCAL_PRIMARY_USER_ID',
    'CLOUDFLARE_API_TOKEN',
  ])
})

test('setup fails closed for the EdgeOne stub and malformed YAML', () => {
  const edgeone = tempConfig('airingcal.yaml', 'schema_version: 1\nplatform: edgeone\n')
  assert.throws(() => runAiringcalSetup(edgeone), /edgeone/)

  const broken = tempConfig('airingcal.yaml', 'schema_version: 1\nplatform: [unclosed\n')
  assert.throws(() => runAiringcalSetup(broken), /YAML is invalid/)

  const wrongSchema = tempConfig('airingcal.yaml', 'schema_version: 2\nplatform: portable\n')
  assert.throws(() => runAiringcalSetup(wrongSchema), /schema_version/)
})
