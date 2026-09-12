import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const imagePattern = /^ghcr\.io\/skyline-gazer\/airing-cal-sync:[0-9a-f]{40}$/
const requiredEnvironment = ['DATABASE_URL', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_REGION']

function hasWritableTmpfs(tmpfs) {
  return Array.isArray(tmpfs) && tmpfs.some((mount) => {
    if (typeof mount !== 'string') return false
    const [target, options = ''] = mount.split(':', 2)
    const optionSet = new Set(options.split(','))
    return target === '/tmp/airing-cal' && optionSet.has('mode=1777') && !optionSet.has('ro')
  })
}

export function validateVpsComposeText(source) {
  let config
  try {
    config = JSON.parse(source)
  } catch {
    assert.fail('RENDERED_COMPOSE_JSON_REQUIRED')
  }

  const sync = config?.services?.sync
  assert.ok(sync && typeof sync === 'object' && !Array.isArray(sync), 'SYNC_SERVICE_REQUIRED')
  assert.match(sync.image, imagePattern, 'VPS_SYNC_IMAGE_MUST_BE_FULL_SHA')
  assert.equal(sync.init, true, 'SYNC_INIT_REQUIRED')
  assert.equal(sync.read_only, true, 'SYNC_READ_ONLY_REQUIRED')
  assert.equal(sync.user, 'node', 'SYNC_NON_ROOT_USER_REQUIRED')
  assert.ok(Array.isArray(sync.cap_drop) && sync.cap_drop.includes('ALL'), 'SYNC_CAP_DROP_ALL_REQUIRED')
  assert.ok(hasWritableTmpfs(sync.tmpfs), 'SYNC_TMPFS_MUST_BE_WRITABLE')
  for (const key of requiredEnvironment) assert.ok(Object.hasOwn(sync.environment ?? {}, key), `SYNC_RUNTIME_ENV_REQUIRED:${key}`)
  for (const key of ['ports', 'restart', 'privileged', 'volumes']) assert.equal(Object.hasOwn(sync, key), false, 'ONE_SHOT_BOUNDARY_VIOLATION')
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [path] = process.argv.slice(2)
  if (!path) throw new Error('RENDERED_COMPOSE_PATH_REQUIRED')
  validateVpsComposeText(readFileSync(path, 'utf8'))
}
