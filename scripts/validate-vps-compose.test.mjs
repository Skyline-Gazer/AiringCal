import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { validateImageReference, validateVpsCompose } from './validate-vps-compose.mjs'

const root = resolve(import.meta.dirname, '..')
const validImage = `ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}`

test('rejects floating, debug, and short image references', () => {
  for (const image of [
    'ghcr.io/skyline-gazer/airing-cal-sync:latest',
    'ghcr.io/skyline-gazer/airing-cal-sync:debug',
    `ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}-debug`,
    'ghcr.io/skyline-gazer/airing-cal-sync:abcdef0',
    'docker.io/skyline-gazer/airing-cal-sync:' + 'a'.repeat(40),
  ]) {
    assert.equal(validateImageReference(image).ok, false, image)
  }
})

test('explains that the manual debug tag is not a production image', () => {
  const result = validateImageReference(`ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}-debug`)

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /debug/)
})

test('accepts only the full production git SHA image reference', () => {
  assert.deepEqual(validateImageReference(validImage), { ok: true, errors: [] })
})

test('validates the one-shot Compose hardening and writable temporary boundary', () => {
  const result = validateVpsCompose({ root, env: { VPS_SYNC_IMAGE: validImage } })

  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.errors, [])
  assert.equal(result.image, validImage)
})

test('fails closed when the supplied image is not an immutable production tag', () => {
  const result = validateVpsCompose({
    root,
    env: { VPS_SYNC_IMAGE: 'ghcr.io/skyline-gazer/airing-cal-sync:latest' },
  })

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /VPS_SYNC_IMAGE/)
})

test('run wrapper takes a non-blocking host lock and never echoes secret values', () => {
  const script = readFileSync(resolve(root, 'deploy/vps/run-sync.sh'), 'utf8')

  assert.match(script, /flock\s+-n\s+9/)
  assert.match(script, /docker\s+compose/)
  assert.match(script, /run\s+--rm\s+sync\s+sync/)
  assert.match(script, /--source=scheduled/)
  assert.doesNotMatch(script, /set\s+-x/)
  assert.doesNotMatch(script, /echo[^\n]*(?:DATABASE_URL|FEISHU_WEBHOOK|R2_SECRET|BANGUMI_TOKEN)/)
})

test('run wrapper rejects an explicitly empty mode instead of defaulting to shadow', () => {
  const result = spawnSync('sh', [resolve(root, 'deploy/vps/run-sync.sh'), ''], { encoding: 'utf8' })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /usage: .*run-sync\.sh \[shadow\|live\]/)
})

test('Compose validator rejects fallback syntax for required environment values', async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'vps-compose-validator-'))
  try {
    await cp(resolve(root, 'deploy'), resolve(temporaryRoot, 'deploy'), { recursive: true })
    const composePath = resolve(temporaryRoot, 'deploy/vps/compose.yaml')
    const compose = await readFile(composePath, 'utf8')
    await writeFile(
      composePath,
      compose.replace(
        'DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}',
        'DATABASE_URL: ${DATABASE_URL:-fallback}',
      ),
    )

    const result = validateVpsCompose({ root: temporaryRoot, env: { VPS_SYNC_IMAGE: validImage } })
    assert.equal(result.ok, false)
    assert.match(result.errors.join('\n'), /DATABASE_URL/)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('secret template and operator guide require a private env file and shadow-first run', () => {
  const env = readFileSync(resolve(root, 'deploy/vps/.env.example'), 'utf8')
  const readme = readFileSync(resolve(root, 'deploy/vps/README.md'), 'utf8')

  for (const name of [
    'VPS_SYNC_IMAGE',
    'DATABASE_URL',
    'BANGUMI_TOKEN',
    'BANGUMI_USERS',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'FEISHU_WEBHOOK_URL',
    'FEISHU_WEBHOOK_TOKEN',
    'FEISHU_WEBHOOK_SECRET',
    'FEISHU_TIMEOUT_MS',
  ]) {
    assert.match(env, new RegExp(`^${name}=`, 'm'), `${name} must be in .env.example`)
  }
  assert.match(readme, /chmod\s+600/)
  assert.match(readme, /run-sync\.sh\s+shadow/)
  assert.match(readme, /04:00/)
  assert.match(readme, /flock/)
})
