import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const PRODUCTION_TARGET = 'production'
export const DEBUG_TARGET = 'debug'

const root = resolve(import.meta.dirname, '..')
const verifiedDebugPackages = ['curl', 'bind-tools', 'netcat-openbsd', 'procps-ng', 'iproute2', 'jq']
const forbiddenProductionPackages = [
  ['git', /\bgit(?:-lfs)?\b/i],
  ['curl', /\bcurl\b/i],
  ['python', /\bpython(?:3)?\b/i],
  ['editor', /\b(?:vim|nano|emacs|vi)\b/i],
  ['jq', /\bjq\b/i],
  ['DNS tools', /\bbind-tools\b/i],
  ['TCP tools', /\bnetcat-openbsd\b/i],
  ['TypeScript', /\btypescript\b/i],
  ['tsx', /\btsx\b/i],
  ['pnpm', /(?:^|[\s@])pnpm(?:[\s@]|$)/i],
]

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function requireMatch(errors, text, pattern, message) {
  if (!text || !pattern.test(text)) errors.push(message)
}

function requireAbsent(errors, text, pattern, message) {
  if (text && pattern.test(text)) errors.push(message)
}

function checkStaticFiles(workspaceRoot) {
  const errors = []
  const warnings = []
  const dockerfilePath = resolve(workspaceRoot, 'Dockerfile.vps-sync')
  const dockerignorePath = resolve(workspaceRoot, '.dockerignore')
  const packagePath = resolve(workspaceRoot, 'apps/vps-sync/package.json')
  const rootPackagePath = resolve(workspaceRoot, 'package.json')
  const dockerfile = read(dockerfilePath)
  const dockerignore = read(dockerignorePath)
  const packageText = read(packagePath)
  const rootPackageText = read(rootPackagePath)

  if (!dockerfile) errors.push('Dockerfile.vps-sync is missing')
  if (!dockerignore) errors.push('.dockerignore is missing')
  if (!packageText) errors.push('apps/vps-sync/package.json is missing')
  if (!rootPackageText) errors.push('root package.json is missing')
  if (!dockerfile || !dockerignore || !packageText || !rootPackageText) return { errors, warnings, dockerfile, dockerignore, packageText }

  let packageJson
  try {
    packageJson = JSON.parse(packageText)
  } catch {
    errors.push('apps/vps-sync/package.json is not valid JSON')
  }
  let rootPackageJson
  try {
    rootPackageJson = JSON.parse(rootPackageText)
  } catch {
    errors.push('root package.json is not valid JSON')
  }

  requireMatch(errors, dockerfile, /FROM\s+node:alpine\s+AS\s+dependencies/i, 'dependencies target must use node:alpine')
  requireMatch(errors, dockerfile, /FROM\s+dependencies\s+AS\s+build/i, 'build target must extend dependencies')
  requireMatch(errors, dockerfile, /FROM\s+build\s+AS\s+runtime-compile/i, 'runtime-compile target must extend build')
  requireMatch(errors, dockerfile, /FROM\s+node:alpine\s+AS\s+production/i, 'production target must use node:alpine')
  requireMatch(errors, dockerfile, /FROM\s+production\s+AS\s+debug/i, 'debug target must extend production')
  requireMatch(errors, dockerfile, /pnpm\s+-F\s+@airing-cal\/vps-sync\s+build/, 'build target must invoke the vps-sync build script')
  requireMatch(errors, dockerfile, /pnpm\s+--filter\s+@airing-cal\/vps-sync\s+deploy\s+--prod\s+\/prod/, 'build must deploy production dependencies only')
  requireMatch(errors, dockerfile, /pnpm\s+install\s+--frozen-lockfile/, 'dependencies must use the checked-in pnpm lockfile')
  requireMatch(errors, dockerfile, /npm\s+install\s+--global\s+"?pnpm@\$\{PNPM_VERSION\}/, 'build must install the pinned pnpm version')

  const productionStart = dockerfile.search(/FROM\s+node:alpine\s+AS\s+production/i)
  const debugStart = dockerfile.search(/FROM\s+production\s+AS\s+debug/i)
  const production = productionStart >= 0 && debugStart > productionStart
    ? dockerfile.slice(productionStart, debugStart)
    : ''
  const debug = debugStart >= 0 ? dockerfile.slice(debugStart) : ''

  requireMatch(errors, production, /apk\s+add\s+--no-cache[\s\S]*ca-certificates/, 'production must install CA certificates')
  requireMatch(errors, production, /apk\s+add\s+--no-cache[\s\S]*postgresql17-client/, 'production must install the verified PostgreSQL client')
  requireMatch(errors, production, /USER\s+node\b/, 'production must run as the non-root node user')
  requireMatch(errors, production, /ENV\s+TMPDIR=\/tmp\b/, 'production must keep temporary writes under /tmp')
  requireMatch(errors, production, /ENTRYPOINT\s*\[\s*["']node["'],\s*["']dist\/cli\.js["']\s*\]/, 'production must execute the compiled CLI')
  requireMatch(errors, production, /COPY\s+--from=build\s+\/workspace\/apps\/vps-sync\/dist\/\s+\.\/dist\//, 'production must copy the compiled vps-sync dist directory')
  requireMatch(errors, production, /COPY\s+--from=build\s+\/prod\/node_modules\s+\.\/node_modules/, 'production must copy only deployed production dependencies')
  requireMatch(errors, production, /rm\s+-rf\s+[^\n]*\/npm\s+[^\n]*\/npx\s+[^\n]*\/corepack/, 'production must remove the package-manager executables')
  requireAbsent(errors, production, /EXPOSE\s+/i, 'production must not expose a listening port')
  requireAbsent(errors, production, /COPY\s+\.\s+\./i, 'production must not copy the source context')
  requireAbsent(errors, production, /COPY\s+--from=(?:build|dependencies)\s+[^\n]*\/src(?:\/|\s)/i, 'production must not copy TypeScript source')
  requireAbsent(errors, production, /COPY\s+--from=runtime-compile\s+\/runtime\/apps\/vps-sync/i, 'production must use the build dist instead of recompiling the app into the image')
  requireAbsent(errors, production, /COPY\s+[^\n]*\.test\.[^\s/]*/i, 'production must not copy tests')
  for (const [packageName, pattern] of forbiddenProductionPackages) {
    requireAbsent(errors, production, pattern, `production must not install ${packageName}`)
  }

  for (const packageName of verifiedDebugPackages) {
    requireMatch(errors, debug, new RegExp(`\\b${packageName}\\b`), `debug must include verified package ${packageName}`)
  }
  requireAbsent(errors, production, new RegExp(verifiedDebugPackages.map((value) => `\\b${value}\\b`).join('|')), 'debug-only packages must not appear in production')

  for (const pattern of ['.git', 'node_modules', '**/dist', '**/*.test.ts', '**/*.test.mjs']) {
    requireMatch(errors, dockerignore, new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `.dockerignore must exclude ${pattern}`)
  }

  if (packageJson) {
    if (rootPackageJson?.packageManager !== 'pnpm@9.15.9') errors.push('root packageManager and Docker pnpm version must stay at pnpm@9.15.9')
    if (packageJson.name !== '@airing-cal/vps-sync') errors.push('vps-sync package name changed unexpectedly')
    if (packageJson.scripts?.build !== 'tsc && cp -R src/postgres/migrations/. dist/postgres/migrations/') {
      errors.push('vps-sync build script must preserve the verified dist/migrations contract')
    }
    if (packageJson.scripts?.start !== 'node dist/cli.js') errors.push('vps-sync start script must execute dist/cli.js')
  }

  warnings.push('read-only root filesystem and capability dropping are runtime policy checks; Task 7.2 Compose must enforce them')
  return { errors, warnings, dockerfile, dockerignore, packageText }
}

function inspectImageConfig(image) {
  if (!image) return { status: 'skipped', reason: 'no image reference supplied' }
  try {
    const output = execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const [metadata] = JSON.parse(output)
    const config = metadata?.Config ?? {}
    const errors = []
    const user = String(config.User ?? '').split(':', 1)[0]
    if (!user || user === '0' || user === 'root') errors.push('image config user is root or unset')
    if (config.ExposedPorts && Object.keys(config.ExposedPorts).length > 0) errors.push('image config exposes a port')
    if (JSON.stringify(config.Entrypoint) !== JSON.stringify(['node', 'dist/cli.js'])) errors.push('image config entrypoint is not node dist/cli.js')
    return { status: errors.length === 0 ? 'pass' : 'fail', errors, config }
  } catch (error) {
    return { status: 'skipped', reason: `docker image inspect unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function verifyVpsSyncImage({ root: workspaceRoot = root, image } = {}) {
  const staticResult = checkStaticFiles(workspaceRoot)
  const imageResult = inspectImageConfig(image)
  const errors = [...staticResult.errors, ...(imageResult.errors ?? [])]
  return {
    ok: errors.length === 0,
    errors,
    warnings: staticResult.warnings,
    static: {
      dockerfile: Boolean(staticResult.dockerfile),
      dockerignore: Boolean(staticResult.dockerignore),
      package: Boolean(staticResult.packageText),
    },
    image: imageResult,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = verifyVpsSyncImage({ image: process.env.VPS_SYNC_IMAGE })
  for (const warning of result.warnings) console.warn(`WARN ${warning}`)
  for (const error of result.errors) console.error(`FAIL ${error}`)
  if (result.image.status === 'skipped') console.warn(`SKIP ${result.image.reason}`)
  process.exitCode = result.ok ? 0 : 1
}
