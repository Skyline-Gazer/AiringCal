import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

export const VERIFIED_ACTIONS = Object.freeze({
  'actions/checkout': 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
  'actions/setup-node': 'a0853c24544627f65ddf259abe73b1d18a591444',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
  'docker/build-push-action': '10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  'docker/login-action': 'c94ce9fb468520275223c153574b00df6fe4bcc9',
  'docker/metadata-action': 'c299e40c65443455700f0fdfc63efafe5b349051',
  'docker/setup-buildx-action': '8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
  'pnpm/action-setup': 'a7487c7e89a18df4991f7f222e4898a00d66ddda',
})

function requireText(errors, source, pattern, message) {
  if (!pattern.test(source)) errors.push(message)
}

function requireBefore(errors, source, first, second, message) {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) errors.push(message)
}

function stepBlock(source, name) {
  const marker = `      - name: ${name}\n`
  const start = source.indexOf(marker)
  if (start < 0) return ''
  const body = source.slice(start + marker.length)
  const next = body.search(/^      - name:/m)
  return next < 0 ? body : body.slice(0, next)
}

function requireStepMatch(errors, source, name, pattern, message) {
  const block = stepBlock(source, name)
  if (!block || !pattern.test(block)) errors.push(message)
  return block
}

function validateActions(errors, source) {
  const uses = [...source.matchAll(/^\s*uses:\s*([^\s@]+)@([^\s#]+)(?:\s+#.*)?$/gm)]
  if (uses.length === 0) errors.push('workflow must pin every action to a commit SHA')

  for (const [, action, reference] of uses) {
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      errors.push(`${action} must use a commit SHA, not a mutable action tag`)
      continue
    }
    const expected = VERIFIED_ACTIONS[action]
    if (expected && expected !== reference) {
      errors.push(`${action} is not pinned to the verified commit SHA`)
    }
  }

  for (const action of Object.keys(VERIFIED_ACTIONS)) {
    if (!uses.some(([, name]) => name === action)) errors.push(`workflow must use ${action}`)
  }
}

export function validateVpsImageWorkflow({ text, workspaceRoot = root } = {}) {
  const workflowPath = resolve(workspaceRoot, '.github/workflows/vps-sync-image.yml')
  const source = text ?? (existsSync(workflowPath) ? readFileSync(workflowPath, 'utf8') : '')
  const errors = []

  if (!source) return { ok: false, errors: ['.github/workflows/vps-sync-image.yml is missing'], warnings: [] }

  requireText(errors, source, /^name:\s+Publish VPS sync production image\s*$/m, 'workflow name must identify the production image')
  requireText(errors, source, /^on:\s*$/m, 'workflow must declare its triggers')
  requireText(errors, source, /^  push:\s*$/m, 'workflow must publish on push')
  requireText(errors, source, /^  workflow_dispatch:\s*$/m, 'workflow must expose a manual debug trigger')
  requireText(errors, source, /^    inputs:\s*$/m, 'manual debug trigger must declare inputs')
  requireText(errors, source, /^      debug:\s*$/m, 'manual trigger must expose an explicit debug input')
  requireText(errors, source, /^        required:\s+true\s*$/m, 'debug input must be explicit')
  requireText(errors, source, /^        type:\s+boolean\s*$/m, 'debug input must be boolean')
  requireText(errors, source, /^concurrency:\s*\n\s+group:\s+vps-sync-image-\$\{\{ github\.ref \}\}\s*\n\s+cancel-in-progress:\s+false\s*$/m, 'workflow must define non-cancelling concurrency')
  requireText(errors, source, /^      contents:\s+read\s*$/m, 'job must grant contents: read')
  requireText(errors, source, /^      packages:\s+write\s*$/m, 'job must grant packages: write')

  validateActions(errors, source)

  requireBefore(errors, source, 'run: pnpm typecheck', 'push: true', 'pnpm typecheck must run before the registry push')
  requireBefore(errors, source, 'run: pnpm test', 'push: true', 'pnpm test must run before the registry push')
  requireBefore(errors, source, 'run: pnpm build:check', 'push: true', 'pnpm build:check must run before the registry push')

  const productionGuard = requireStepMatch(errors, source, 'Refuse an existing full-SHA tag', /^        if:\s+github\.event_name == 'push'\s*$/m, 'full-SHA preflight must run only for push production publishing')
  const productionMetadata = requireStepMatch(errors, source, 'Extract image metadata', /^        if:\s+github\.event_name == 'push'\s*$/m, 'production metadata must run only for push production publishing')
  requireStepMatch(errors, source, 'Build and push production image', /^        if:\s+github\.event_name == 'push'\s*$/m, 'production image push must run only for push production publishing')
  requireStepMatch(errors, source, 'Write image metadata', /^        if:\s+github\.event_name == 'push'\s*$/m, 'production metadata writing must run only for push production publishing')
  requireStepMatch(errors, source, 'Upload image metadata', /^        if:\s+github\.event_name == 'push'\s*$/m, 'production metadata upload must run only for push production publishing')
  requireStepMatch(errors, source, 'Build and push production image', /^          target:\s+production\s*$/m, 'production image push must target the production stage')
  requireStepMatch(errors, source, 'Build and push production image', /^          push:\s+true\s*$/m, 'production image build must push to the registry')
  requireStepMatch(errors, source, 'Build and push production image', /^          tags:\s+\$\{\{ steps\.meta\.outputs\.tags \}\}\s*$/m, 'production build-push must consume production metadata tags')

  const debugMetadata = requireStepMatch(errors, source, 'Extract debug image metadata', /^        if:\s+github\.event_name == 'workflow_dispatch' && inputs\.debug == true\s*$/m, 'debug metadata must require the explicit manual debug input')
  const debugBuild = requireStepMatch(errors, source, 'Build and push debug image', /^        if:\s+github\.event_name == 'workflow_dispatch' && inputs\.debug == true\s*$/m, 'debug image push must require the explicit manual debug input')
  requireStepMatch(errors, source, 'Build and push debug image', /^          target:\s+debug\s*$/m, 'debug image push must target the debug stage')
  requireStepMatch(errors, source, 'Build and push debug image', /^          push:\s+true\s*$/m, 'debug image build must push to the registry')
  requireStepMatch(errors, source, 'Build and push debug image', /^          tags:\s+\$\{\{ steps\.debug-meta\.outputs\.tags \}\}\s*$/m, 'debug build-push must consume debug metadata tags')

  requireText(errors, productionMetadata, /type=raw,value=\$\{\{ github\.sha \}\}\s*$/m, 'production image tags must include the full SHA')
  requireText(errors, productionMetadata, /type=raw,value=latest,enable=\{\{is_default_branch\}\}/, 'production image tags must include a non-authoritative discovery tag')
  requireText(errors, debugMetadata, /type=raw,value=\$\{\{ github\.sha \}\}-debug\s*$/m, 'debug image tags must be exactly the full SHA followed by -debug')
  if (/type=sha(?:,|\s|$)/.test(source)) errors.push('short metadata-action SHA tags are not allowed; use the full SHA')
  requireText(errors, source, /^\s+IMAGE_NAME:\s+skyline-gazer\/airing-cal-sync\s*$/m, 'workflow must publish the Compose image name')

  requireText(errors, source, /docker buildx imagetools inspect node:alpine --format '\{\{json \.Manifest\}\}'/, 'workflow must resolve node:alpine manifest metadata')
  requireText(errors, source, /docker buildx imagetools inspect node:alpine --format '\{\{json \.Image\}\}'/, 'workflow must record node:alpine image metadata')
  requireText(errors, source, /docker-library\/official-images\/master\/library\/node/, 'workflow must read official node metadata')
  requireText(errors, source, /NODE_MAJOR:\s+'26'/, 'workflow must pin the verified current Node major')
  requireText(errors, source, /node-version:\s+26\s*$/m, 'Node major mismatch: setup-node must match the verified node:alpine major')
  requireText(errors, source, /manifest_digest=/, 'workflow must export the resolved base manifest digest')
  requireText(errors, source, /org\.opencontainers\.image\.base\.digest=/, 'image labels must include the resolved base digest')

  requireText(errors, productionGuard, /\/v2\/\$\{repository\}\/manifests\/\$\{GITHUB_SHA\}/, 'full-SHA preflight must inspect the exact immutable tag')
  requireText(errors, productionGuard, /404\).*Full SHA tag is absent/, 'full-SHA preflight must allow only a not-found response')
  requireText(errors, productionGuard, /200\).*Full SHA tag already exists/, 'full-SHA preflight must reject an existing tag')
  requireText(errors, productionGuard, /Could not prove full SHA tag is absent/, 'full-SHA preflight must fail closed on unknown registry responses')

  requireText(errors, source, /GITHUB_STEP_SUMMARY/, 'workflow must write an image metadata job summary')
  requireText(errors, source, /actions\/upload-artifact@/, 'workflow must upload image metadata')
  requireText(errors, source, /^\s+overwrite:\s+false\s*$/m, 'metadata artifact overwrite must be disabled')
  requireText(errors, source, /^\s+if-no-files-found:\s+error\s*$/m, 'metadata artifact must fail when missing')

  const forbidden = [
    [/secrets\.(?!GITHUB_TOKEN\b)/, 'VPS secret'],
    [/docker\.sock|\/var\/run\/docker/, 'Docker socket'],
    [/^\s*(?:ssh|scp):/im, 'SSH'],
    [/\b(?:DATABASE_URL|BANGUMI_TOKEN|R2_SECRET_ACCESS_KEY|FEISHU_WEBHOOK_URL)\b/, 'VPS secret'],
    [/\b(?:wrangler|docker compose)\b/, 'deployment'],
  ]
  for (const [pattern, label] of forbidden) {
    if (pattern.test(source)) errors.push(`workflow must not contain ${label} credentials or behavior`)
  }

  return { ok: errors.length === 0, errors, warnings: [] }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateVpsImageWorkflow()
  for (const warning of result.warnings) console.warn(`WARN ${warning}`)
  for (const error of result.errors) console.error(`FAIL ${error}`)
  process.exitCode = result.ok ? 0 : 1
}
