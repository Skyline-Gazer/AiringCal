import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const validImage = `ghcr.io/skyline-gazer/airing-cal-sync:${'a'.repeat(40)}`

function compose(image = validImage, overrides = {}) {
  return JSON.stringify({
    services: {
      sync: {
        image,
        init: true,
        read_only: true,
        user: 'node',
        cap_drop: ['ALL'],
        tmpfs: ['/tmp/airing-cal:rw,noexec,nosuid,size=64m,mode=1777'],
        environment: {
          DATABASE_URL: 'postgres://example',
          R2_ENDPOINT: 'https://example.r2.cloudflarestorage.com',
          R2_BUCKET: 'airing-cal',
          R2_ACCESS_KEY_ID: 'example',
          R2_SECRET_ACCESS_KEY: 'example',
          R2_REGION: 'auto',
        },
        ...overrides,
      },
    },
  })
}

function validate(source) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `import { validateVpsComposeText } from './scripts/validate-vps-compose.mjs'; validateVpsComposeText(${JSON.stringify(source)})`], {
    encoding: 'utf8',
  })
}

function expectRejected(source, reason) {
  const result = validate(source)
  assert.notEqual(result.status, 0, result.stderr)
  assert.match(result.stderr, new RegExp(reason))
}

test('rejects floating, debug, and short VPS image tags', () => {
  for (const tag of ['latest', 'debug', 'a'.repeat(39)]) {
    expectRejected(compose(`ghcr.io/skyline-gazer/airing-cal-sync:${tag}`), 'VPS_SYNC_IMAGE_MUST_BE_FULL_SHA')
  }
})

test('accepts a full SHA-pinned one-shot image', () => {
  const result = validate(compose())
  assert.equal(result.status, 0, result.stderr)
})

test('rejects rendered configurations that weaken the one-shot boundary', () => {
  for (const unsafe of [{ ports: ['8080:8080'] }, { restart: 'always' }, { privileged: true }, { volumes: ['/var/run/docker.sock:/var/run/docker.sock'] }]) {
    expectRejected(compose(validImage, unsafe), 'ONE_SHOT_BOUNDARY_VIOLATION')
  }
})

test('accepts a rendered non-root read-only configuration with writable /tmp/airing-cal', () => {
  const result = validate(compose())
  assert.equal(result.status, 0, result.stderr)
})

test('rejects top-level extension security keys that do not secure services.sync', () => {
  const bypass = JSON.stringify({
    'x-irrelevant': JSON.parse(compose()).services.sync,
    services: { sync: { image: validImage } },
  })
  expectRejected(bypass, 'SYNC_INIT_REQUIRED')
})

test('rejects a read-only /tmp/airing-cal mount even with mode 1777', () => {
  expectRejected(compose(validImage, { tmpfs: ['/tmp/airing-cal:ro,mode=1777'] }), 'SYNC_TMPFS_MUST_BE_WRITABLE')
})

test('run-sync rejects an invalid host image before invoking Docker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'airing-cal-run-sync-'))
  try {
    copyFileSync('deploy/vps/run-sync.sh', join(directory, 'run-sync.sh'))
    chmodSync(join(directory, 'run-sync.sh'), 0o755)
    writeFileSync(join(directory, '.env'), 'VPS_SYNC_IMAGE=ghcr.io/skyline-gazer/airing-cal-sync:latest\n')
    writeFileSync(join(directory, 'flock'), '#!/usr/bin/env sh\n[ "$1" = -n ] && shift\nshift\nexec "$@"\n')
    writeFileSync(join(directory, 'docker'), '#!/usr/bin/env sh\ntouch "$DOCKER_CALLED"\n')
    chmodSync(join(directory, 'flock'), 0o755)
    chmodSync(join(directory, 'docker'), 0o755)
    const marker = join(directory, 'docker-called')
    const result = spawnSync(join(directory, 'run-sync.sh'), ['live'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, DOCKER_CALLED: marker },
    })
    assert.notEqual(result.status, 0, result.stderr)
    assert.match(result.stderr, /VPS_SYNC_IMAGE_MUST_BE_FULL_SHA/)
    assert.equal(existsSync(marker), false, 'Docker must not be invoked for an invalid image')
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('run-sync uses its validated host image instead of an inherited override', () => {
  const directory = mkdtempSync(join(tmpdir(), 'airing-cal-run-sync-'))
  try {
    copyFileSync('deploy/vps/run-sync.sh', join(directory, 'run-sync.sh'))
    chmodSync(join(directory, 'run-sync.sh'), 0o755)
    writeFileSync(join(directory, '.env'), `VPS_SYNC_IMAGE=${validImage}\n`)
    writeFileSync(join(directory, 'flock'), '#!/usr/bin/env sh\n[ "$1" = -n ] && shift\nshift\nexec "$@"\n')
    writeFileSync(join(directory, 'docker'), '#!/usr/bin/env sh\ntest -z "$VPS_SYNC_IMAGE"\ntouch "$DOCKER_CALLED"\n')
    chmodSync(join(directory, 'flock'), 0o755)
    chmodSync(join(directory, 'docker'), 0o755)
    const marker = join(directory, 'docker-called')
    const result = spawnSync(join(directory, 'run-sync.sh'), ['live'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, VPS_SYNC_IMAGE: 'ghcr.io/skyline-gazer/airing-cal-sync:latest', DOCKER_CALLED: marker },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(marker), true)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})
