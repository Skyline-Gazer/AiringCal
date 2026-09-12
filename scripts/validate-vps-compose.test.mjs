import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const validImage = `ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}`

function compose(image = validImage) {
  return `services:\n  sync:\n    image: ${image}\n    init: true\n    read_only: true\n    user: node\n    cap_drop:\n      - ALL\n    tmpfs:\n      - /tmp/airing-cal:rw,noexec,nosuid,size=64m,mode=1777\n    environment:\n      DATABASE_URL: postgres://example\n      R2_ENDPOINT: https://example.r2.cloudflarestorage.com\n      R2_BUCKET: airing-cal\n      R2_ACCESS_KEY_ID: example\n      R2_SECRET_ACCESS_KEY: example\n      R2_REGION: auto\n`
}

function validate(source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `import { validateVpsComposeText } from './scripts/validate-vps-compose.mjs'; validateVpsComposeText(${JSON.stringify(source)})`], {
    encoding: 'utf8',
  })
}

test('rejects floating, debug, and short VPS image tags', () => {
  for (const tag of ['latest', 'debug', 'a'.repeat(39)]) {
    const result = validate(compose(`ghcr.io/skyline-gazer/airing-cal-sync:${tag}`))
    assert.notEqual(result.status, 0, result.stderr)
  }
})

test('accepts a full SHA-pinned one-shot image', () => {
  const result = validate(compose())
  assert.equal(result.status, 0, result.stderr)
})

test('rejects rendered configurations that weaken the one-shot boundary', () => {
  for (const unsafe of ['    ports:\n      - "8080:8080"\n', '    restart: always\n', '    privileged: true\n', '    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n']) {
    const result = validate(`${compose()}${unsafe}`)
    assert.notEqual(result.status, 0, result.stderr)
  }
})

test('accepts a rendered non-root read-only configuration with writable /tmp/airing-cal', () => {
  const result = validate(compose())
  assert.equal(result.status, 0, result.stderr)
})
