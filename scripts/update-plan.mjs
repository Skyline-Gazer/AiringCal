/**
 * Self-service in-place update: release discovery, workspace upgrade and
 * toolchain gating. The pure planning helpers are kept separate from IO so the
 * wizard and the committed tests share exactly one decision path.
 *
 * An update has two steps that must never be conflated:
 *   1. move this workspace to the published release tag (git + pnpm install);
 *   2. deploy that release through the existing writer contract
 *      (operation=update + First Full Sync, owned by setup-wizard).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveTargetRepository } from './deploy-env-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const STABLE_TAG_RE = /^v\d+\.\d+\.\d+$/

export const CANONICAL_REPOSITORY = 'Skyline-Gazer/AiringCal'

export function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** Semver precedence, including prerelease ordering. Null when unparsable. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const l = left.prerelease[index]
    const r = right.prerelease[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const lNumeric = /^\d+$/.test(l)
    const rNumeric = /^\d+$/.test(r)
    if (lNumeric && rNumeric) {
      const diff = Number(l) - Number(r)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (lNumeric) return -1
    if (rNumeric) return 1
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

export function latestStableRelease(releases) {
  let best = null
  for (const release of releases ?? []) {
    const tag = String(release?.tag ?? '').trim()
    if (release?.draft || release?.prerelease || !STABLE_TAG_RE.test(tag)) continue
    if (!best || compareVersions(tag, best.tag) > 0) best = { ...release, tag }
  }
  return best
}

/**
 * Decide what the update must do for this workspace. `upgrade` needs a clean
 * tree because it moves HEAD; `redeploy` only re-runs the writer.
 */
export function planUpdate({ localVersion, localTag = null, targetTag, writerRef, dirty }) {
  if (!targetTag || !parseVersion(targetTag)) {
    return {
      action: 'unknown',
      target: null,
      code: 'UPDATE_TARGET_UNKNOWN',
      reasons: ['No published stable release was found; the wizard will use the local version and its own release review.'],
    }
  }
  const tagLabel = localTag && parseVersion(localTag) ? localTag : null
  const localLabel = tagLabel ?? String(localVersion ?? '')
  const comparison = tagLabel
    ? compareVersions(tagLabel, targetTag)
    : compareVersions(localVersion, targetTag)
  if (comparison === null) {
    return {
      action: 'unknown',
      target: targetTag,
      code: 'UPDATE_VERSION_UNPARSABLE',
      reasons: [`Cannot compare workspace version "${localLabel}" with ${targetTag}; continuing without a version gate.`],
    }
  }
  if (comparison > 0) {
    return {
      action: 'blocked',
      target: targetTag,
      code: 'UPDATE_LOCAL_AHEAD',
      reasons: [`Workspace ${localLabel} is newer than the latest published release ${targetTag}; refusing to downgrade.`],
    }
  }
  if (comparison < 0) {
    if (dirty) {
      return {
        action: 'blocked',
        target: targetTag,
        code: 'UPDATE_WORKSPACE_DIRTY',
        reasons: ['This workspace has uncommitted changes; commit or stash them before upgrading.'],
      }
    }
    return {
      action: 'upgrade',
      target: targetTag,
      code: 'UPDATE_UPGRADE',
      reasons: [`Workspace ${localLabel} can move to ${targetTag}.`],
    }
  }
  if (writerRef && writerRef !== targetTag) {
    return {
      action: 'redeploy',
      target: targetTag,
      code: 'UPDATE_REDEPLOY',
      reasons: [`Workspace is at ${targetTag}; the deployment is still ${writerRef}.`],
    }
  }
  return {
    action: 'current',
    target: targetTag,
    code: 'UPDATE_CURRENT',
    reasons: [`Workspace and deployment are at ${targetTag}.`],
  }
}

/**
 * Minimal engine-range matcher for the range syntax this repo writes
 * (`>=24`, `>=22.12.0`, ...). Unsupported syntax returns null = "unknown,
 * do not block" instead of inventing a verdict.
 */
export function satisfiesRange(version, range) {
  if (!parseVersion(version)) return null
  const parts = String(range ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return true
  for (const part of parts) {
    const match = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(part)
    if (!match) return null
    const op = match[1] ?? '='
    const comparison = compareVersions(version, `${match[2]}.${match[3] ?? '0'}.${match[4] ?? '0'}`)
    if (comparison === null) return null
    const ok = op === '>='
      ? comparison >= 0
      : op === '<='
        ? comparison <= 0
        : op === '>'
          ? comparison > 0
          : op === '<'
            ? comparison < 0
            : comparison === 0
    if (!ok) return false
  }
  return true
}

export function toolchainBlockers({ pkg, nodeVersion = process.versions.node, pnpmVersion = null }) {
  const blockers = []
  const nodeRange = String(pkg?.engines?.node ?? '').trim()
  if (nodeRange && satisfiesRange(nodeVersion, nodeRange) === false) {
    blockers.push({
      code: 'UPDATE_NODE_UNSUPPORTED',
      severity: 'block',
      message: `This release requires Node.js ${nodeRange}; you are running ${nodeVersion}.`,
      fix: `Install Node.js ${nodeRange} (for example: nvm install 24 && nvm use 24), then rerun pnpm setup.`,
    })
  }
  const manager = String(pkg?.packageManager ?? '').trim()
  const pinned = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manager)
  if (pinned && pnpmVersion && pnpmVersion !== pinned[1]) {
    blockers.push({
      code: 'UPDATE_PNPM_UNSUPPORTED',
      severity: 'warn',
      message: `This release pins pnpm ${pinned[1]} (packageManager); you are running ${pnpmVersion}.`,
      fix: `Run corepack prepare pnpm@${pinned[1]} --activate (or npm i -g pnpm@${pinned[1]}), then rerun pnpm setup.`,
    })
  }
  return blockers
}

export function readLocalPackage(cwd = ROOT) {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
}

export function readPnpmVersion(spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('pnpm', ['--version'], { encoding: 'utf8', cwd: ROOT })
  const value = result?.status === 0 ? String(result.stdout ?? '').trim() : ''
  return /^\d+\.\d+\.\d+/.test(value) ? value : null
}

export function readTaggedPackage({ tag, cwd = ROOT, spawnSyncImpl = spawnSync }) {
  const result = spawnSyncImpl('git', ['show', `${tag}:package.json`], { encoding: 'utf8', cwd })
  if (result?.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

function ghJson({ args, spawnSyncImpl, cwd = ROOT }) {
  const result = spawnSyncImpl('gh', args, { encoding: 'utf8', cwd })
  if (result?.status !== 0) return null
  try {
    return JSON.parse(String(result.stdout ?? '').trim() || 'null')
  } catch {
    return null
  }
}

export function readUpstreamRepository({ repo, spawnSyncImpl = spawnSync, cwd = ROOT }) {
  const payload = ghJson({
    args: ['api', `repos/${repo}`, '--jq', '{parent: (.parent.full_name // "")}'],
    spawnSyncImpl,
    cwd,
  })
  const parent = String(payload?.parent ?? '').trim()
  return parent || repo
}

export function listStableReleases({ repo, spawnSyncImpl = spawnSync, cwd = ROOT }) {
  const payload = ghJson({
    args: [
      'api',
      `repos/${repo}/releases?per_page=50`,
      '--jq',
      '[.[] | {tag: .tag_name, draft, prerelease, publishedAt: .published_at}]',
    ],
    spawnSyncImpl,
    cwd,
  })
  return Array.isArray(payload) ? payload : null
}

export function readEnvironmentVariables({ repo, environment, spawnSyncImpl = spawnSync, cwd = ROOT }) {
  const payload = ghJson({
    args: [
      'api',
      `repos/${repo}/environments/${environment}/variables`,
      '--jq',
      '[.variables[] | {name, value}]',
    ],
    spawnSyncImpl,
    cwd,
  })
  if (!Array.isArray(payload)) return null
  const variables = {}
  for (const entry of payload) {
    const name = String(entry?.name ?? '').trim()
    if (name) variables[name] = String(entry?.value ?? '')
  }
  return variables
}

export async function readDeployedVersion({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const origin = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!origin) return { reachable: false, version: null, detail: 'no public base URL recorded' }
  try {
    const response = await fetchImpl(`${origin}/api/version`, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { reachable: false, version: null, detail: `HTTP ${response.status}` }
    const body = await response.json().catch(() => null)
    const version = String(body?.package ?? '').trim()
    return { reachable: true, version: version && version !== '0.0.0' ? version : null, detail: null }
  } catch (error) {
    return { reachable: false, version: null, detail: String(error?.message ?? error).slice(0, 120) }
  }
}

export function formatUpdateState(state) {
  const lines = [
    `Workspace: ${state.localVersion}${state.localTag ? ` (${state.localTag})` : ''} ${state.dirty ? '[uncommitted changes]' : '[clean]'}`,
    `Target:    ${state.target?.tag ?? 'unknown'}${state.target ? ` (${String(state.target.sha ?? '').slice(0, 8) || 'sha unresolved'})` : ''}`,
    `Deployed:  ${state.writerRef ?? 'unknown'}`,
  ]
  if (state.deployedVersion) lines.push(`Reader:    ${state.deployedVersion}`)
  else if (state.deployedDetail) lines.push(`Reader:    unreachable (${state.deployedDetail})`)
  lines.push(`Action:    ${state.plan.action}${state.plan.code ? ` (${state.plan.code})` : ''}`)
  for (const reason of state.plan.reasons ?? []) lines.push(`           ${reason}`)
  return lines.join('\n')
}

/**
 * Read-only discovery: no Cloudflare token, no deployment mutation. GitHub
 * reads are best-effort because an unauthenticated or offline host must still
 * be able to run the wizard.
 */
export async function discoverUpdateState({
  environment,
  env = {},
  repo = null,
  cwd = ROOT,
  fetchImpl = globalThis.fetch,
  spawnSyncImpl = spawnSync,
  baseUrl = null,
} = {}) {
  const resolvedRepo = repo ?? resolveTargetRepository({ env, spawnSyncImpl, cwd }).repository
  const pkg = readLocalPackage(cwd)
  const localVersion = String(pkg.version ?? '').trim()
  const status = spawnSyncImpl('git', ['status', '--porcelain'], { encoding: 'utf8', cwd })
  const dirty = status?.status === 0 && String(status.stdout ?? '').trim().length > 0
  const exact = spawnSyncImpl('git', ['describe', '--tags', '--exact-match', '--match', 'v[0-9]*'], {
    encoding: 'utf8',
    cwd,
  })
  const localTag = exact?.status === 0 ? String(exact.stdout ?? '').trim() || null : null
  const head = spawnSyncImpl('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd })
  const headSha = head?.status === 0 ? String(head.stdout ?? '').trim() : null

  let upstreamRepo = resolvedRepo
  let releases = null
  let variables = null
  if (environment === 'production') {
    upstreamRepo = readUpstreamRepository({ repo: resolvedRepo, spawnSyncImpl, cwd })
    releases = listStableReleases({ repo: upstreamRepo, spawnSyncImpl, cwd })
    variables = readEnvironmentVariables({ repo: resolvedRepo, environment, spawnSyncImpl, cwd })
  }
  const latest = latestStableRelease(releases)
  const envPrefix = `AIRINGCAL_${String(environment ?? '').toUpperCase()}`
  const writerRef = String(variables?.[`${envPrefix}_RELEASE_REF`] ?? '').trim() || null
  const publicBaseUrl = String(variables?.[`${envPrefix}_PUBLIC_BASE_URL`] ?? baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '')

  let targetSha = null
  if (latest?.tag) {
    const resolved = spawnSyncImpl('git', ['rev-list', '-n', '1', latest.tag], { encoding: 'utf8', cwd })
    targetSha = resolved?.status === 0 ? String(resolved.stdout ?? '').trim() || null : null
  }
  const deployed = await readDeployedVersion({ baseUrl: publicBaseUrl, fetchImpl })
  const plan = planUpdate({ localVersion, localTag, targetTag: latest?.tag ?? null, writerRef, dirty })
  return {
    repository: resolvedRepo,
    upstreamRepo,
    environment,
    localVersion,
    localTag,
    headSha,
    dirty,
    writerRef,
    publicBaseUrl,
    deployedVersion: deployed.version,
    deployedDetail: deployed.detail,
    target: latest ? { tag: latest.tag, sha: targetSha } : null,
    plan,
  }
}

function updateError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Move the workspace to the published release tag. The caller owns the
 * dependency install and the re-exec of the (now updated) wizard.
 */
export function upgradeWorkspace({
  targetTag,
  targetSha = null,
  upstreamRepo,
  cwd = ROOT,
  spawnSyncImpl = spawnSync,
  log = () => {},
} = {}) {
  const runGit = (args) => spawnSyncImpl('git', args, { encoding: 'utf8', cwd })
  const existing = runGit(['rev-parse', '-q', '--verify', `refs/tags/${targetTag}^{commit}`])
  const existingSha = existing?.status === 0 ? String(existing.stdout ?? '').trim().toLowerCase() : ''
  if (existingSha && targetSha && existingSha !== targetSha) {
    throw updateError(
      'UPDATE_TAG_CONFLICT',
      `Local tag ${targetTag} points at ${existingSha.slice(0, 8)}, but the published release is ${String(targetSha).slice(0, 8)}. Delete the stale local tag and retry.`,
    )
  }
  if (!existingSha) {
    const fetched = runGit([
      'fetch',
      '--no-tags',
      `https://github.com/${upstreamRepo}.git`,
      `refs/tags/${targetTag}:refs/tags/${targetTag}`,
    ])
    if (fetched?.status !== 0) {
      throw updateError(
        'UPDATE_FETCH_FAILED',
        `Could not fetch ${targetTag} from ${upstreamRepo}: ${String(fetched?.stderr ?? 'git fetch failed').trim().slice(0, 200)}`,
      )
    }
  }
  const previous = runGit(['rev-parse', 'HEAD'])
  const previousHead = previous?.status === 0 ? String(previous.stdout ?? '').trim() : null
  const moved = runGit(['-c', 'advice.detachedHead=false', 'checkout', '--detach', targetTag])
  if (moved?.status !== 0) {
    throw updateError(
      'UPDATE_CHECKOUT_FAILED',
      `git checkout ${targetTag} failed: ${String(moved?.stderr ?? '').trim().slice(0, 200)}`,
    )
  }
  const head = runGit(['rev-parse', 'HEAD'])
  const headSha = head?.status === 0 ? String(head.stdout ?? '').trim() : ''
  if (targetSha && headSha !== targetSha) {
    throw updateError(
      'UPDATE_CHECKOUT_MISMATCH',
      `Workspace HEAD is ${headSha.slice(0, 8)} after checkout, expected ${String(targetSha).slice(0, 8)}.`,
    )
  }
  log(`Workspace updated to ${targetTag} (${headSha.slice(0, 8)}); previous HEAD ${previousHead.slice(0, 8)}.`)
  return { previousHead, targetTag, headSha }
}