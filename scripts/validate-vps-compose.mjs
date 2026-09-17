import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const IMAGE_PATTERN = /^ghcr\.io\/skyline-gazer\/airing-cal-sync:[0-9a-f]{40}$/

const root = resolve(import.meta.dirname, '..')
const requiredEnvironment = [
  'DATABASE_URL',
  'BANGUMI_TOKEN',
  'BANGUMI_USERS',
  'R2_ENDPOINT',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'FEISHU_WEBHOOK_URL',
]

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function serviceBlock(compose) {
  const start = compose.indexOf('\n  sync:\n')
  if (start < 0) return ''
  const body = compose.slice(start + '\n  sync:\n'.length)
  const nextService = body.search(/^  [a-zA-Z0-9_-]+:\s*$/m)
  return nextService < 0 ? body : body.slice(0, nextService)
}

function requireMatch(errors, text, pattern, message) {
  if (!text || !pattern.test(text)) errors.push(message)
}

function requireAbsent(errors, text, pattern, message) {
  if (text && pattern.test(text)) errors.push(message)
}

export function validateImageReference(image) {
  const errors = []
  if (typeof image !== 'string' || !IMAGE_PATTERN.test(image)) {
    errors.push('VPS_SYNC_IMAGE must be a full production git SHA reference: ghcr.io/skyline-gazer/airing-cal-sync:<40 lowercase hex>')
  }
  return { ok: errors.length === 0, errors }
}

function validateFiles(workspaceRoot) {
  const compose = read(resolve(workspaceRoot, 'deploy/vps/compose.yaml'))
  const envExample = read(resolve(workspaceRoot, 'deploy/vps/.env.example'))
  const runScript = read(resolve(workspaceRoot, 'deploy/vps/run-sync.sh'))
  const readme = read(resolve(workspaceRoot, 'deploy/vps/README.md'))
  const errors = []
  const warnings = []

  if (!compose) errors.push('deploy/vps/compose.yaml is missing')
  if (!envExample) errors.push('deploy/vps/.env.example is missing')
  if (!runScript) errors.push('deploy/vps/run-sync.sh is missing')
  if (!readme) errors.push('deploy/vps/README.md is missing')
  if (!compose || !envExample || !runScript || !readme) return { errors, warnings, compose, envExample, runScript, readme }

  const service = serviceBlock(compose)
  requireMatch(errors, compose, /^services:\s*$/m, 'Compose must declare services')
  requireMatch(errors, compose, /^  sync:\s*$/m, 'Compose must declare the sync service')
  requireMatch(errors, service, /^    image:\s+\$\{VPS_SYNC_IMAGE:\?[^}]+\}\s*$/m, 'sync image must be required through VPS_SYNC_IMAGE')
  requireMatch(errors, service, /^    command:\s*\[\s*["']sync["']\s*\]\s*$/m, 'sync service must default to the one-shot sync command')
  requireMatch(errors, service, /^    init:\s*true\s*$/m, 'sync service must enable init')
  requireMatch(errors, service, /^    read_only:\s*true\s*$/m, 'sync service must use a read-only root filesystem')
  requireMatch(errors, service, /^    user:\s*["']?node["']?\s*$/m, 'sync service must run as the non-root node user')
  requireMatch(errors, service, /^    cap_drop:\s*\n\s+-\s+ALL\s*$/m, 'sync service must drop all capabilities')
  requireMatch(errors, service, /^    tmpfs:\s*\n\s+-\s+\/tmp\/airing-cal:mode=1777\s*$/m, 'sync service must provide writable /tmp/airing-cal tmpfs')

  for (const key of requiredEnvironment) {
    requireMatch(errors, service, new RegExp(`^      ${key}:\\s+\\$\\{${key}:\\?[^}]+\\}\\s*$`, 'm'), `sync service must require ${key} through Compose`)
  }
  requireMatch(errors, service, /^      FEISHU_WEBHOOK_TOKEN:\s+\$\{FEISHU_WEBHOOK_TOKEN:-\}\s*$/m, 'sync service must pass the optional Feishu token')
  requireMatch(errors, service, /^      FEISHU_WEBHOOK_SECRET:\s+\$\{FEISHU_WEBHOOK_SECRET:-\}\s*$/m, 'sync service must pass the optional Feishu secret')
  requireMatch(errors, service, /^      FEISHU_TIMEOUT_MS:\s+\$\{FEISHU_TIMEOUT_MS:-10000\}\s*$/m, 'sync service must pass the bounded Feishu timeout')

  for (const forbidden of [/^    ports:/m, /^    restart:/m, /^    privileged:/m, /^    volumes:/m]) {
    requireAbsent(errors, service, forbidden, `sync service must not contain ${forbidden.source.slice(5, -2)}`)
  }
  requireAbsent(errors, compose, /docker\.sock|\/var\/run\/docker/i, 'Compose must not mount the Docker socket')

  for (const key of requiredEnvironment.concat(['FEISHU_WEBHOOK_TOKEN', 'FEISHU_WEBHOOK_SECRET', 'FEISHU_TIMEOUT_MS'])) {
    requireMatch(errors, envExample, new RegExp(`^${key}=`, 'm'), `${key} must be present in .env.example`)
  }
  requireMatch(errors, envExample, /^VPS_SYNC_IMAGE=ghcr\.io\/skyline-gazer\/airing-cal-sync:[0-9a-f]{40}\s*$/m, '.env.example must use a full SHA-shaped image placeholder')
  requireMatch(errors, runScript, /flock\s+-n\s+9/, 'run-sync.sh must use a non-blocking host flock')
  requireMatch(errors, runScript, /docker\s+compose[\s\S]*run\s+--rm\s+sync\s+sync/, 'run-sync.sh must invoke the one-shot Compose sync service')
  requireMatch(errors, runScript, /--source=scheduled/, 'run-sync.sh must mark host-cron runs as scheduled')
  requireAbsent(errors, runScript, /set\s+-x|echo[^\n]*(?:DATABASE_URL|BANGUMI_TOKEN|R2_SECRET|FEISHU_WEBHOOK)/i, 'run-sync.sh must not echo secrets')
  requireMatch(errors, readme, /chmod\s+600/, 'README must require private env-file permissions')
  requireMatch(errors, readme, /run-sync\.sh\s+shadow/, 'README must document the shadow run')

  return { errors, warnings, compose, envExample, runScript, readme }
}

export function validateVpsCompose({ root: workspaceRoot = root, env = process.env } = {}) {
  const result = validateFiles(workspaceRoot)
  const image = env.VPS_SYNC_IMAGE
  if (image === undefined) {
    result.warnings.push('VPS_SYNC_IMAGE is not set; pass a full 40-character git SHA before running')
  } else {
    const imageResult = validateImageReference(image)
    result.errors.push(...imageResult.errors)
  }
  return {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    image: image ?? null,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateVpsCompose()
  for (const warning of result.warnings) console.warn(`WARN ${warning}`)
  for (const error of result.errors) console.error(`FAIL ${error}`)
  process.exitCode = result.ok ? 0 : 1
}
