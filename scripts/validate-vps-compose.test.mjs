import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { validateImageReference, validateVpsCompose } from './validate-vps-compose.mjs'

const root = resolve(import.meta.dirname, '..')
const validImage = `ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}`

test('rejects floating, debug, and short image references', () => {
  for (const image of [
    'ghcr.io/skyline-gazer/airing-cal-sync:latest',
    'ghcr.io/skyline-gazer/airing-cal-sync:debug',
    'ghcr.io/skyline-gazer/airing-cal-sync:abcdef0',
    'docker.io/skyline-gazer/airing-cal-sync:' + 'a'.repeat(40),
  ]) {
    assert.equal(validateImageReference(image).ok, false, image)
  }
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
