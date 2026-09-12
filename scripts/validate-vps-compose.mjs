import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const imagePattern = /^ghcr\.io\/skyline-gazer\/airing-cal-sync:[0-9a-f]{40}$/
const requiredEnvironment = ['DATABASE_URL', 'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_REGION']

export function validateVpsComposeText(source) {
  const images = [...source.matchAll(/^\s*image:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((match) => match[1])
  assert.deepEqual(images.length, 1, 'VPS_SYNC_IMAGE_REQUIRED_ONCE')
  assert.match(images[0], imagePattern, 'VPS_SYNC_IMAGE_MUST_BE_FULL_SHA')
  assert.match(source, /^\s*init:\s*true\s*$/m, 'INIT_REQUIRED')
  assert.match(source, /^\s*read_only:\s*true\s*$/m, 'READ_ONLY_REQUIRED')
  assert.match(source, /^\s*user:\s*node\s*$/m, 'NON_ROOT_USER_REQUIRED')
  assert.match(source, /^\s*cap_drop:\s*\n\s*-\s*ALL\s*$/m, 'CAP_DROP_ALL_REQUIRED')
  assert.match(source, /^\s*-\s*\/tmp\/airing-cal:.*mode=1777\s*$/m, 'WRITABLE_TMPFS_REQUIRED')
  for (const key of requiredEnvironment) assert.match(source, new RegExp(`^\\s+${key}:`, 'm'), `RUNTIME_ENV_REQUIRED:${key}`)
  assert.doesNotMatch(source, /^\s*(?:ports|restart|privileged|volumes):/m, 'ONE_SHOT_BOUNDARY_VIOLATION')
  assert.doesNotMatch(source, /docker\.sock/, 'DOCKER_SOCKET_FORBIDDEN')
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [path] = process.argv.slice(2)
  if (!path) throw new Error('RENDERED_COMPOSE_PATH_REQUIRED')
  validateVpsComposeText(readFileSync(path, 'utf8'))
}
