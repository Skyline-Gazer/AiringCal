import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveTargetRepository } from './deploy-env-lib.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const HEX_40_RE = /^[0-9a-f]{40}$/
const STABLE_TAG_RE = /^v?\d+\.\d+\.\d+$/

function git(spawnSyncImpl, args, cwd = ROOT) {
  const res = spawnSyncImpl('git', args, { cwd, encoding: 'utf8' })
  return {
    ok: res?.status === 0,
    status: typeof res?.status === 'number' ? res.status : null,
    out: String(res?.stdout ?? '').trim(),
    err: String(res?.stderr ?? '').trim(),
  }
}

function ghApi(spawnSyncImpl, path, jqExpr, env = {}) {
  const res = spawnSyncImpl('gh', ['api', path, '--jq', jqExpr], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return res?.status === 0 ? String(res.stdout ?? '').trim() : null
}

function ghJson(spawnSyncImpl, path) {
  const res = spawnSyncImpl('gh', ['api', path], { encoding: 'utf8' })
  if (res?.status !== 0) return null
  try {
    return JSON.parse(String(res.stdout ?? ''))
  } catch {
    return null
  }
}

/** Parse `v3.0.0` / `3.0.0-rc.1`; anything else is not a release version. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff > 0 ? 1 : -1
      continue
    }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** Semver precedence; `null` when either side is not a version. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** Highest non-draft, non-prerelease `vX.Y.Z` release. */
export function latestStableRelease(releases) {
  if (!Array.isArray(releases)) return null
  let best = null
  for (const release of releases) {
    const tag = String(release?.tag ?? release?.tag_name ?? '').trim()
    if (!STABLE_TAG_RE.test(tag)) continue
    if (release?.draft === true || release?.prerelease === true) continue
    if (best === null || compareVersions(tag, best.tag) > 0) best = { tag }
  }
  return best
}

/** Engine ranges this repository writes: `>=X`, `>X`, `X`, `^X`, `~X`, `*`. */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  const text = String(range ?? '').trim()
  if (!parsed || !text) return null
  if (text === '*' || text.toLowerCase() === 'x') return true
  if (/\s/.test(text)) {
    const results = text.split(/\s+/).filter(Boolean).map((clause) => satisfiesRange(version, clause))
    if (results.some((result) => result === false)) return false
    return results.every((result) => result === true) ? true : null
  }

  const op = /^(>=|>|<=|<|=|\^|~)/.exec(text)?.[0] ?? ''
  const rawBound = text.slice(op.length).trim()
  // `>=24` and `^24.1` are ordinary engine ranges; a partial version binds at zero.
  const bound = rawBound.replace(/^(\d+)(?:\.(\d+))?$/, (_, major, minor) => `${major}.${minor ?? 0}.0`)
  const parsedBound = parseVersion(bound)
  if (!parsedBound) return null
  const cmp = compareVersions(version, bound)
  if (cmp === null) return null

  switch (op) {
    case '>=': return cmp >= 0
    case '>': return cmp > 0
    case '<=': return cmp <= 0
    case '<': return cmp < 0
    case '=': return cmp === 0
    case '~': return cmp >= 0 && parsed.major === parsedBound.major && parsed.minor === parsedBound.minor
    case '^': return cmp >= 0 && parsed.major === parsedBound.major
    default: return cmp === 0
  }
}

export function readPnpmVersion(spawnSyncImpl = spawnSync) {
  const res = spawnSyncImpl('pnpm', ['--version'], { encoding: 'utf8' })
  return res?.status === 0 ? String(res.stdout ?? '').trim() : null
}

function pnpmMajor(version) {
  const match = /^(\d+)/.exec(String(version ?? ''))
  return match ? Number(match[1]) : null
}

/**
 * Toolchain requirements from the *target release* package.json.
 * Node below engines.node blocks; a pnpm major mismatch also blocks so
 * `pnpm install --frozen-lockfile` never fails mid-upgrade after switching HEAD.
 */
export function toolchainBlockers({ pkg = {}, nodeVersion, pnpmVersion } = {}) {
  const blockers = []
  const engines = pkg?.engines ?? {}
  const nodeRange = String(engines.node ?? '').trim()
  const pnpmRange = String(engines.pnpm ?? '').trim()
  const packageManager = String(pkg?.packageManager ?? '').trim()
  const managerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager)
  const expectedPnpm = managerMatch ? managerMatch[1] : null

  if (nodeRange) {
    const ok = satisfiesRange(nodeVersion, nodeRange)
    if (ok === false) {
      blockers.push({
        kind: 'node',
        severity: 'block',
        code: 'UPDATE_NODE_TOO_OLD',
        message: `This release needs Node ${nodeRange}; running ${nodeVersion}.`,
        fix: `Install Node ${nodeRange} (https://nodejs.org/en/download), then rerun pnpm setup.`,
      })
    }
  }

  if (expectedPnpm && pnpmVersion) {
    const expectedMajor = pnpmMajor(expectedPnpm)
    const actualMajor = pnpmMajor(pnpmVersion)
    if (expectedMajor !== null && actualMajor !== expectedMajor) {
      blockers.push({
        kind: 'pnpm',
        severity: 'block',
        code: 'UPDATE_PNPM_MISMATCH',
        message: `This release declares pnpm ${expectedPnpm}; running ${pnpmVersion}.`,
        fix: `corepack prepare pnpm@${expectedPnpm} --activate`,
      })
    }
  } else if (pnpmRange && pnpmVersion) {
    const ok = satisfiesRange(pnpmVersion, pnpmRange)
    if (ok === false) {
      blockers.push({
        kind: 'pnpm',
        severity: 'block',
        code: 'UPDATE_PNPM_MISMATCH',
        message: `This release needs pnpm ${pnpmRange}; running ${pnpmVersion}.`,
        fix: `corepack prepare pnpm@${expectedPnpm ?? 'latest'} --activate`,
      })
    }
  }

  return blockers
}

/** Workspace facts the decision depends on. `statusOk:false` is never "clean". */
export function readLocalState({ cwd = ROOT, spawnSyncImpl = spawnSync } = {}) {
  const head = git(spawnSyncImpl, ['rev-parse', 'HEAD'], cwd)
  const status = git(spawnSyncImpl, ['status', '--porcelain=v1'], cwd)
  const tagRes = git(spawnSyncImpl, ['describe', '--tags', '--exact-match', '--match', 'v[0-9]*'], cwd)
  const shallowRes = git(spawnSyncImpl, ['rev-parse', '--is-shallow-repository'], cwd)
  let version = null
  try {
    version = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version ?? null
  } catch {
    version = null
  }
  return {
    headSha: head.ok && HEX_40_RE.test(head.out.toLowerCase()) ? head.out.toLowerCase() : null,
    tag: tagRes.ok && STABLE_TAG_RE.test(tagRes.out.split('\n')[0]) ? tagRes.out.split('\n')[0] : null,
    version,
    dirty: status.ok ? status.out.length > 0 : null,
    statusOk: status.ok,
    shallow: shallowRes.ok ? shallowRes.out.toLowerCase() === 'true' : null,
  }
}

/**
 * Resolve the repository that hosts releases. A fork deploys its parent's
 * releases; a fork whose parent cannot be read is unknown, never self.
 */
export function resolveReleaseSourceRepository({ repository, spawnSyncImpl = spawnSync } = {}) {
  const raw = ghJson(spawnSyncImpl, `repos/${repository}`)
  if (!raw || typeof raw.fork !== 'boolean') {
    return { ok: false, code: 'UPDATE_RELEASE_SOURCE_UNKNOWN', reason: `Cannot read repository metadata for ${repository}.` }
  }
  if (raw.fork === true) {
    const parent = String(raw.parent?.full_name ?? '').trim()
    if (!parent) {
      return { ok: false, code: 'UPDATE_RELEASE_SOURCE_UNKNOWN', reason: `${repository} is a fork but its parent repository is not visible.` }
    }
    return { ok: true, repository: parent, source: 'fork-parent' }
  }
  return { ok: true, repository, source: 'canonical' }
}

/**
 * Authoritative commit behind a tag, from GitHub (not the local clone).
 * Handles lightweight tags and annotated tag objects explicitly.
 */
export function readRemoteReleaseIdentity({ repository, tag, spawnSyncImpl = spawnSync } = {}) {
  const trimmed = String(tag ?? '').trim()
  if (!trimmed || !repository) return { ok: false, reason: 'No tag or repository to resolve.' }
  const refRaw = ghApi(spawnSyncImpl, `repos/${repository}/git/ref/tags/${encodeURIComponent(trimmed)}`, '{type:.object.type,sha:.object.sha}')
  if (!refRaw) return { ok: false, reason: `Cannot read tag ${trimmed} from ${repository}.` }
  let ref = null
  try {
    ref = JSON.parse(refRaw)
  } catch {
    return { ok: false, reason: `Tag ${trimmed} returned malformed ref metadata.` }
  }
  const sha = String(ref.sha ?? '').toLowerCase()
  if (ref.type === 'commit' && HEX_40_RE.test(sha)) return { ok: true, sha, annotated: false }
  if (ref.type !== 'tag' || !HEX_40_RE.test(sha)) {
    return { ok: false, reason: `Tag ${trimmed} points to ${ref.type ?? 'an unknown object'}, not a commit.` }
  }
  const tagRaw = ghApi(spawnSyncImpl, `repos/${repository}/git/tags/${sha}`, '{type:.object.type,sha:.object.sha}')
  let tagObject = null
  try {
    tagObject = JSON.parse(tagRaw ?? '')
  } catch {
    tagObject = null
  }
  const commit = String(tagObject?.sha ?? '').toLowerCase()
  if (tagObject?.type === 'commit' && HEX_40_RE.test(commit)) return { ok: true, sha: commit, annotated: true }
  return { ok: false, reason: `Annotated tag ${trimmed} does not resolve to a commit.` }
}

/** Published releases; `null` means "could not read", distinct from `[]`. */
export function readGithubReleases({ repository, spawnSyncImpl = spawnSync } = {}) {
  const raw = ghJson(spawnSyncImpl, `repos/${repository}/releases?per_page=100`)
  if (!Array.isArray(raw)) return null
  return raw.map((release) => ({
    tag: String(release?.tag_name ?? '').trim(),
    draft: release?.draft === true,
    prerelease: release?.prerelease === true,
  }))
}

function classifyGhRead(res) {
  const text = `${res?.stdout ?? ''}\n${res?.stderr ?? ''}`
  if (res?.status === 0) return 'ok'
  if (res?.status === 404 || /\bNot Found\b|\bHTTP 404\b/i.test(text)) return 'absent'
  return 'error'
}

function readEnvironmentVariableDetailed({ repository, environment, key, spawnSyncImpl }) {
  const res = spawnSyncImpl('gh', ['api', `repos/${repository}/environments/${environment}/variables/${key}`, '--jq', '.value'], {
    encoding: 'utf8',
    env: { ...process.env },
  })
  const kind = classifyGhRead(res)
  const value = kind === 'ok' ? String(res.stdout ?? '').trim() || null : null
  const detail = kind === 'error'
    ? String(res?.stderr || res?.stdout || 'GitHub API read failed').trim().slice(0, 300)
    : null
  return { kind, value, detail }
}

/** Live Reader identity; unreachable is a fact, not "no version". */
export async function readReaderVersion({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  const origin = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!origin) return { reachable: false, version: null, commitSha: null, invalidCommitSha: false, reason: 'No Reader origin is known (PUBLIC_BASE_URL is unset).' }
  if (typeof fetchImpl !== 'function') return { reachable: false, version: null, commitSha: null, invalidCommitSha: false, reason: 'No fetch implementation is available.' }
  try {
    const res = await fetchImpl(`${origin}/api/version?_t=${Date.now()}`, {
      cache: 'no-store',
      headers: { 'cache-control': 'no-cache' },
      redirect: 'manual',
    })
    if (Number(res?.status) !== 200) return { reachable: false, version: null, commitSha: null, invalidCommitSha: false, reason: `Reader /api/version returned HTTP ${res?.status}.` }
    const body = await res.json().catch(() => null)
    const version = typeof body?.package === 'string' && body.package !== '0.0.0' ? body.package : null
    const reported = String(body?.build?.commitSha ?? '').trim().toLowerCase()
    const validCommitSha = HEX_40_RE.test(reported)
    const commitSha = validCommitSha ? reported : null
    const invalidCommitSha = Boolean(reported && !validCommitSha)
    return {
      reachable: true,
      version,
      commitSha,
      invalidCommitSha,
      reason: invalidCommitSha
        ? `Reader reported invalid build commit "${reported}".`
        : version ? null : 'Reader reports no package version.',
    }
  } catch (error) {
    return { reachable: false, version: null, commitSha: null, invalidCommitSha: false, reason: `Reader /api/version unreachable: ${error?.message ?? String(error)}` }
  }
}

function blocked(code, message, extra = {}) {
  return { action: 'blocked', code, reasons: [message], ...extra }
}

function unknown(code, message, extra = {}) {
  return { action: 'unknown', code, reasons: [message], ...extra }
}

/**
 * Truthful Update decision. Inputs are facts (remote release identity,
 * deployment references, Reader state); outputs never assume equality.
 */
export function planUpdate({
  environment = 'production',
  local = {},
  target = null,
  writer = null,
  reader = null,
  dirty = false,
  statusOk = true,
} = {}) {
  const headSha = String(local.headSha ?? '').toLowerCase() || null
  const localTag = local.tag && STABLE_TAG_RE.test(local.tag) ? local.tag : null
  const localVersion = local.version ?? null
  const localLabel = localTag
    ?? (localVersion ? `version ${localVersion}` : headSha ? `untagged ${headSha.slice(0, 12)}` : 'unknown')

  if (statusOk === false) {
    return blocked('UPDATE_GIT_STATUS_UNKNOWN', 'Cannot read the workspace git status; resolve it before updating.')
  }

  if (environment === 'development') {
    if (!headSha) return unknown('UPDATE_WORKSPACE_UNKNOWN', 'Cannot read the workspace HEAD commit.')
    if (dirty) return blocked('UPDATE_WORKSPACE_DIRTY', 'This workspace has uncommitted changes; commit or stash them before updating.')
    return {
      action: 'redeploy',
      code: 'UPDATE_DEVELOPMENT_REDEPLOY',
      target: null,
      reasons: [
        `Development deploys the current workspace commit ${headSha.slice(0, 12)}; it has no published-release comparison.`,
        'This updates the existing Development deployment configuration and resources in this repository.',
      ],
    }
  }

  const targetSha = String(target?.sha ?? '').toLowerCase()
  if (!target?.tag || !HEX_40_RE.test(targetSha)) {
    return unknown(
      'UPDATE_TARGET_UNKNOWN',
      String(target?.reason ?? 'The latest published release or its commit cannot be resolved from GitHub.'),
    )
  }
  const targetTag = target.tag
  const targetVersion = parseVersion(targetTag)
  if (!targetVersion) {
    return unknown('UPDATE_TARGET_UNKNOWN', `Published release tag ${targetTag} is not a stable vX.Y.Z tag.`)
  }

  if (!headSha) return unknown('UPDATE_WORKSPACE_UNKNOWN', 'Cannot read the workspace HEAD commit.')

  // A recorded or unreadable Writer identity must be checked BEFORE any workspace upgrade.
  if (writer?.readError === true) {
    return unknown(
      'UPDATE_WRITER_UNREADABLE',
      String(writer?.reason ?? 'Cannot read Writer release variables from GitHub Environment; verify gh auth status and environment permissions.'),
    )
  }
  if (writer?.invalid === true) {
    return unknown(
      'UPDATE_DEPLOYMENT_UNVERIFIED',
      String(writer?.reason ?? 'The Writer configured release identity cannot be validated; deployment state is unknown.'),
    )
  }
  if (writer?.conflict === true) {
    return blocked(
      'UPDATE_DEPLOYMENT_CONFLICT',
      String(writer?.reason ?? `The Writer records two different commits; refusing to assume it targets ${targetTag}.`),
    )
  }

  const writerRef = String(writer?.ref ?? '').trim() || null
  const writerSha = String(writer?.sha ?? '').toLowerCase() || null
  const writerResolved = writerSha !== null && HEX_40_RE.test(writerSha)
  if (writerRef || writerSha) {
    const writerCmp = writerRef ? compareVersions(writerRef, targetTag) : null
    if (!writerResolved) {
      return unknown(
        'UPDATE_DEPLOYMENT_UNVERIFIED',
        `The Writer configured identity (${writerRef ?? 'no RELEASE_REF'}${writerSha ? ` / ${writerSha}` : ''}) is not a resolvable 40-character commit; deployment state is unknown.`,
      )
    }
    if (writerCmp !== null && writerCmp > 0) {
      return blocked('UPDATE_DEPLOYED_AHEAD', `The Writer configured target ${writerRef} is newer than ${targetTag}; refusing to downgrade the deployment.`)
    }
    if (writerCmp === 0 && writerSha !== targetSha) {
      return blocked(
        'UPDATE_DEPLOYMENT_CONFLICT',
        `The Writer configured ${writerRef} (${writerSha.slice(0, 12)}), not the published commit ${targetSha.slice(0, 12)}.`,
      )
    }
    if (!writerRef && writerSha !== targetSha && (writer?.compareStatus === 'ahead' || writer?.compareStatus === 'diverged')) {
      return blocked(
        'UPDATE_DEPLOYED_AHEAD',
        `The Writer configured commit ${writerSha.slice(0, 12)} is ${writer.compareStatus} relative to ${targetTag} (${targetSha.slice(0, 12)}); refusing unsafe downgrade or divergent update.`,
      )
    }
  }

  const atTarget = headSha === targetSha
  if (!atTarget) {
    if (local.shallow === true) {
      return blocked(
        'UPDATE_SHALLOW_CLONE',
        'This is a shallow clone, so an upgrade cannot prove it keeps your history. Run "git fetch --unshallow" and rerun pnpm setup.',
      )
    }
    const dirtyMessage = `Workspace ${localLabel} (${headSha.slice(0, 12)}) differs from ${targetTag} (${targetSha.slice(0, 12)}); uncommitted changes would be lost.`
    const cmp = localTag ? compareVersions(localTag, targetTag) : localVersion ? compareVersions(localVersion, targetTag) : null
    if (cmp === null) {
      return blocked(
        dirty ? 'UPDATE_WORKSPACE_DIRTY' : 'UPDATE_UNTAGGED_DIVERGED',
        dirty
          ? dirtyMessage
          : `Workspace HEAD ${headSha.slice(0, 12)} has no comparable release tag; cannot prove it is behind ${targetTag}.`,
      )
    }
    if (cmp > 0) {
      return blocked('UPDATE_LOCAL_AHEAD', `Workspace ${localLabel} is newer than the latest published release ${targetTag}; refusing to downgrade.`)
    }
    if (cmp === 0) {
      return blocked(
        dirty ? 'UPDATE_WORKSPACE_DIRTY' : 'UPDATE_UNTAGGED_DIVERGED',
        dirty
          ? dirtyMessage
          : `Workspace reports ${localLabel} but HEAD is not the published ${targetTag} commit; refusing to treat different commits as the same release.`,
      )
    }
    if (dirty) return blocked('UPDATE_WORKSPACE_DIRTY', dirtyMessage)
    return {
      action: 'upgrade',
      code: 'UPDATE_UPGRADE',
      target: { tag: targetTag, sha: targetSha },
      reasons: [`Workspace ${localLabel} (${headSha.slice(0, 12)}) can move to ${targetTag} (${targetSha.slice(0, 12)}).`],
    }
  }

  if (dirty) {
    return blocked('UPDATE_WORKSPACE_DIRTY', 'The workspace is at the published release but has uncommitted changes; commit or stash them first.')
  }

  const readerReachable = reader?.reachable === true
  const readerVersion = reader?.version ? String(reader.version) : null
  const readerCommit = String(reader?.commitSha ?? '').toLowerCase() || null
  const readerInvalidCommit = reader?.invalidCommitSha === true
  const readerAtTarget = readerReachable && readerCommit !== null && readerCommit === targetSha
  const readerNote = readerReachable
    ? [
        readerVersion ? `Reader reports ${readerVersion}.` : 'Reader reports no package version.',
        readerCommit
          ? `Reader build commit ${readerCommit.slice(0, 12)}.`
          : readerInvalidCommit
            ? 'Reader reports an invalid build commit.'
            : 'Reader reports no build commit.',
      ].join(' ')
    : `Reader is unreachable (${reader?.reason ?? 'unknown reason'}).`

  const writerAtTarget = writerResolved && writerSha === targetSha
  if (!writerAtTarget) {
    if (!writerRef && !writerSha) {
      return {
        action: 'verify',
        code: 'UPDATE_WRITER_IDENTITY_MISSING',
        target: { tag: targetTag, sha: targetSha },
        reasons: [
          'The workspace is at the published release, but no Writer AIRINGCAL_PRODUCTION_RELEASE_SHA or RELEASE_REF is configured in GitHub Environment.',
          readerNote,
        ],
      }
    }
    return {
      action: 'redeploy',
      code: 'UPDATE_REDEPLOY',
      target: { tag: targetTag, sha: targetSha },
      reasons: [
        `Workspace is at ${targetTag} (${targetSha.slice(0, 12)}) while Writer configured target is ${writerRef ?? writerSha.slice(0, 12)}${writerRef && writerSha ? ` (${writerSha.slice(0, 12)})` : ''}.`,
        readerNote,
      ],
    }
  }

  if (readerAtTarget) {
    return {
      action: 'current',
      code: 'UPDATE_CURRENT',
      target: { tag: targetTag, sha: targetSha },
      reasons: [`Workspace, Writer configured target (${writerSha.slice(0, 12)}) and Reader build agree on ${targetTag}.`],
    }
  }
  if (!readerReachable) {
    return {
      action: 'verify',
      code: 'UPDATE_READER_UNREACHABLE',
      target: { tag: targetTag, sha: targetSha },
      reasons: [
        `Workspace and Writer configured target agree on ${targetTag}, but the live Reader cannot be reached.`,
        readerNote,
      ],
    }
  }
  if (!readerCommit) {
    if (readerInvalidCommit) {
      return {
        action: 'redeploy',
        code: 'UPDATE_READER_IDENTITY_INVALID',
        target: { tag: targetTag, sha: targetSha },
        reasons: [
          `Workspace and Writer configured target agree on ${targetTag}, but the Reader reports a malformed build commit.`,
          'Redeploying the Reader injects a valid 40-character BANGUMI_GIT_COMMIT_SHA.',
        ],
      }
    }
    return {
      action: 'redeploy',
      code: 'UPDATE_READER_LEGACY_MIGRATION',
      target: { tag: targetTag, sha: targetSha },
      reasons: [
        `Workspace and Writer configured target agree on ${targetTag}, but the legacy Reader does not expose build.commitSha.`,
        'Redeploying the Reader injects BANGUMI_GIT_COMMIT_SHA without modifying R2 data or Writer secrets.',
      ],
    }
  }
  return {
    action: 'redeploy',
    code: 'UPDATE_REDEPLOY',
    target: { tag: targetTag, sha: targetSha },
    reasons: [
      `Workspace and Writer configured target agree on ${targetTag}, but the Reader serves build ${readerCommit.slice(0, 12)}.`,
      'Redeploying the Reader re-converges the deployment.',
    ],
  }
}

/** Read `package.json` from an already-fetched release commit. */
export function readPackageAt({ sha, cwd = ROOT, spawnSyncImpl = spawnSync } = {}) {
  const commit = String(sha ?? '').trim().toLowerCase()
  if (!HEX_40_RE.test(commit)) return null
  const res = git(spawnSyncImpl, ['show', `${commit}:package.json`], cwd)
  if (!res.ok) return null
  try {
    return JSON.parse(res.out)
  } catch {
    return null
  }
}

/** Read `package.json` from a target commit without mutating local git refs. */
export function readRemotePackageAt({ repository, sha, cwd = ROOT, spawnSyncImpl = spawnSync } = {}) {
  const local = readPackageAt({ sha, cwd, spawnSyncImpl })
  if (local) return local
  const commit = String(sha ?? '').trim().toLowerCase()
  if (!repository || !HEX_40_RE.test(commit)) return null
  const encoded = ghApi(spawnSyncImpl, `repos/${repository}/contents/package.json?ref=${commit}`, '.content')
  if (!encoded) return null
  try {
    const decoded = Buffer.from(encoded.replace(/\s+/g, ''), 'base64').toString('utf8')
    return JSON.parse(decoded)
  } catch {
    return null
  }
}

function localTagCommit({ tag, cwd, spawnSyncImpl }) {
  const res = git(spawnSyncImpl, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], cwd)
  const sha = res.out.toLowerCase()
  return res.ok && HEX_40_RE.test(sha) ? sha : null
}

/** Read-only check for a conflicting local tag before prompting or fetching. */
export function checkLocalTagConflict({ tag, sha, cwd = ROOT, spawnSyncImpl = spawnSync } = {}) {
  const targetTag = String(tag ?? '').trim()
  const targetSha = String(sha ?? '').trim().toLowerCase()
  if (!targetTag || !HEX_40_RE.test(targetSha)) return { conflict: false, existingSha: null }
  const existing = localTagCommit({ tag: targetTag, cwd, spawnSyncImpl })
  if (existing && existing !== targetSha) {
    return {
      conflict: true,
      existingSha: existing,
      code: 'UPDATE_TAG_CONFLICT',
      reason: `Local tag ${targetTag} points to ${existing.slice(0, 12)}, but the published release is ${targetSha.slice(0, 12)}.`,
    }
  }
  return { conflict: false, existingSha: existing }
}

/**
 * Fetch the release tag before validating the target's toolchain metadata.
 * A local tag at a different commit is a conflict, never force-overwritten.
 */
export function fetchReleaseTag({ tag, sha, remote = 'origin', cwd = ROOT, spawnSyncImpl = spawnSync } = {}) {
  const targetTag = String(tag ?? '').trim()
  const targetSha = String(sha ?? '').trim().toLowerCase()
  if (!targetTag || !HEX_40_RE.test(targetSha)) {
    return { ok: false, code: 'UPDATE_TARGET_UNKNOWN', reason: 'The published release tag or commit is missing.' }
  }
  const existing = localTagCommit({ tag: targetTag, cwd, spawnSyncImpl })
  if (existing === targetSha) return { ok: true, fetched: false, sha: existing }
  if (existing) {
    return {
      ok: false,
      code: 'UPDATE_TAG_CONFLICT',
      reason: `Local tag ${targetTag} points to ${existing.slice(0, 12)}, but the published release is ${targetSha.slice(0, 12)}.`,
    }
  }
  const source = String(remote ?? '').trim() || 'origin'
  const fetched = git(spawnSyncImpl, ['fetch', '--no-tags', source, `refs/tags/${targetTag}:refs/tags/${targetTag}`], cwd)
  if (!fetched.ok) {
    return { ok: false, code: 'UPDATE_FETCH_FAILED', reason: `Cannot fetch ${targetTag} from ${source}: ${fetched.err.slice(0, 300) || 'git fetch failed'}` }
  }
  const after = localTagCommit({ tag: targetTag, cwd, spawnSyncImpl })
  if (after !== targetSha) {
    return {
      ok: false,
      code: 'UPDATE_TAG_MISMATCH',
      reason: `Fetched ${targetTag} resolves to ${after?.slice(0, 12) ?? 'nothing'}, not the published ${targetSha.slice(0, 12)}.`,
    }
  }
  return { ok: true, fetched: true, sha: after }
}

/** Move the workspace to the published commit, verifying every step. */
export function upgradeWorkspace({ targetTag, targetSha, remote = 'origin', cwd = ROOT, spawnSyncImpl = spawnSync, log = () => {} } = {}) {
  const sha = String(targetSha ?? '').trim().toLowerCase()
  if (!HEX_40_RE.test(sha)) {
    return { ok: false, code: 'UPDATE_TARGET_UNKNOWN', reason: 'The published release commit is missing.' }
  }
  const status = git(spawnSyncImpl, ['status', '--porcelain=v1'], cwd)
  if (!status.ok) return { ok: false, code: 'UPDATE_GIT_STATUS_UNKNOWN', reason: 'Cannot read the workspace git status.' }
  if (status.out.length > 0) {
    return { ok: false, code: 'UPDATE_WORKSPACE_DIRTY', reason: 'The workspace has uncommitted changes; commit or stash them first.' }
  }

  // Ancestry cannot be proven from a shallow history, and fetching first would not fix it.
  const shallow = git(spawnSyncImpl, ['rev-parse', '--is-shallow-repository'], cwd)
  if (shallow.ok && String(shallow.out).toLowerCase() === 'true') {
    return {
      ok: false,
      code: 'UPDATE_SHALLOW_CLONE',
      reason: 'This is a shallow clone, so an upgrade cannot prove it keeps your history. Run "git fetch --unshallow" and rerun pnpm setup.',
    }
  }

  const fetched = fetchReleaseTag({ tag: targetTag, sha, remote, cwd, spawnSyncImpl })
  if (!fetched.ok) return fetched

  const previousHead = git(spawnSyncImpl, ['rev-parse', 'HEAD'], cwd).out.toLowerCase()
  const branch = git(spawnSyncImpl, ['symbolic-ref', '--short', '-q', 'HEAD'], cwd)

  // Only a fast-forward keeps local work reachable; anything else would discard commits.
  if (previousHead !== sha) {
    const ancestor = git(spawnSyncImpl, ['merge-base', '--is-ancestor', previousHead, sha], cwd)
    if (ancestor.status !== 0) {
      return {
        ok: false,
        code: 'UPDATE_UNTAGGED_DIVERGED',
        reason: `Workspace commit ${previousHead.slice(0, 12)} is not an ancestor of ${targetTag} (${sha.slice(0, 12)}); updating would discard local commits. Keep them first: git branch my-work ${previousHead.slice(0, 12)}`,
      }
    }
  }

  log(`Upgrading workspace to ${targetTag} (${sha.slice(0, 12)}).`)
  const switched = git(spawnSyncImpl, ['switch', '--detach', sha], cwd)
  if (!switched.ok) {
    return { ok: false, code: 'UPDATE_CHECKOUT_FAILED', reason: switched.err.slice(0, 300) || 'git switch failed' }
  }
  const head = git(spawnSyncImpl, ['rev-parse', 'HEAD'], cwd).out.toLowerCase()
  if (head !== sha) {
    return {
      ok: false,
      code: 'UPDATE_CHECKOUT_MISMATCH',
      reason: `Workspace is at ${head.slice(0, 12)} after switching, not ${sha.slice(0, 12)}.`,
    }
  }
  const rollback = branch.ok && branch.out
    ? `git switch ${branch.out}`
    : `git switch --detach ${previousHead.slice(0, 12)}`
  return { ok: true, previousHead, headSha: sha, branch: branch.ok ? branch.out : null, rollback }
}

export function formatUpdateState(state = {}) {
  const environment = state.environment ?? 'production'
  const local = state.local ?? {}
  const localLabel = local.tag ?? (local.version ? `version ${local.version}` : 'unknown')
  const workspaceState = local.statusOk === false
    ? 'git status unreadable'
    : local.dirty === true ? 'uncommitted changes' : local.dirty === false ? 'clean' : 'status unknown'
  const lines = [
    `Environment: ${environment} (installation ${state.repository ?? 'unknown'})`,
    `Workspace:   ${localLabel} at ${String(local.headSha ?? '').slice(0, 12) || 'unknown'}, ${workspaceState}`,
  ]
  if (environment === 'production') {
    lines.push(
      state.target
        ? `Target:      ${state.target.tag} (${String(state.target.sha).slice(0, 12)}${state.target.annotated ? ', annotated tag' : ''}) from ${state.releaseSource?.repository ?? 'unknown'}`
        : `Target:      unknown${state.releaseError ? ` (${state.releaseError})` : ''}`,
      state.writer
        ? state.writer.readError
          ? `Writer:      unreadable (${state.writer.reason})`
          : `Writer:      ${[state.writer.ref, state.writer.sha ? `-> ${String(state.writer.sha).slice(0, 12)}` : '(no commit)'].filter(Boolean).join(' ')} (configured target)${state.writer.invalid ? ` [unvalidated: ${state.writer.reason}]` : ''}${state.writer.conflict ? ' [conflicting ref/sha]' : ''}`
        : 'Writer:      no RELEASE_SHA or RELEASE_REF configured',
    )
  } else {
    lines.push('Target:      current workspace commit (Development has no published-release comparison)')
  }
  const reader = state.reader
  lines.push(
    reader?.reachable
      ? `Reader:      reachable${reader.version ? `, ${reader.version}` : ', no package version'}${reader.commitSha ? `, build ${String(reader.commitSha).slice(0, 12)}` : reader.invalidCommitSha ? ', invalid build commit' : ', no build commit'}`
      : `Reader:      unreachable${reader?.reason ? ` (${reader.reason})` : ''}`,
    `Action:      ${state.plan?.action ?? 'unknown'} (${state.plan?.code ?? 'UPDATE_TARGET_UNKNOWN'})`,
  )
  for (const reason of state.plan?.reasons ?? []) lines.push(`  - ${reason}`)
  return lines.join('\n')
}

/**
 * Discover workspace, release-source, target release, deployment references
 * and Reader state. Every failure is carried in the plan, never defaulted.
 */
export async function discoverUpdateState({
  environment = 'production',
  env = {},
  fetchImpl = globalThis.fetch,
  spawnSyncImpl = spawnSync,
  baseUrl = null,
  cwd = ROOT,
} = {}) {
  const environmentName = String(environment).trim().toLowerCase()
  const repository = resolveTargetRepository({ env, spawnSyncImpl, forMutation: false }).repository
  const local = readLocalState({ cwd, spawnSyncImpl })

  const production = environmentName === 'production'
  let releaseSource = { ok: true, repository, source: 'development' }
  let releases = null
  let releaseError = null
  let target = null

  if (production) {
    releaseSource = resolveReleaseSourceRepository({ repository, spawnSyncImpl })
    if (releaseSource.ok) {
      releases = readGithubReleases({ repository: releaseSource.repository, spawnSyncImpl })
      if (releases === null) {
        releaseError = `Cannot list published releases from ${releaseSource.repository}.`
      } else {
        const latest = latestStableRelease(releases)
        if (!latest) {
          releaseError = `No stable release tag is published in ${releaseSource.repository}.`
        } else {
          const identity = readRemoteReleaseIdentity({ repository: releaseSource.repository, tag: latest.tag, spawnSyncImpl })
          if (identity.ok) {
            target = { tag: latest.tag, sha: identity.sha, annotated: identity.annotated === true }
          } else {
            releaseError = identity.reason
          }
        }
      }
    } else {
      releaseError = releaseSource.reason
    }
  }

  const prefix = environmentName.toUpperCase()
  const variable = (key) => readEnvironmentVariableDetailed({ repository, environment: environmentName, key, spawnSyncImpl })
  const writerRefRes = production ? variable(`AIRINGCAL_${prefix}_RELEASE_REF`) : { kind: 'absent', value: null, detail: null }
  const writerShaRes = production ? variable(`AIRINGCAL_${prefix}_RELEASE_SHA`) : { kind: 'absent', value: null, detail: null }
  const writerRef = writerRefRes.value
  const writerShaVariable = writerShaRes.value
  let writer = null
  if (production && (writerRefRes.kind === 'error' || writerShaRes.kind === 'error')) {
    const details = [writerRefRes, writerShaRes]
      .filter((entry) => entry.kind === 'error')
      .map((entry) => entry.detail)
      .filter(Boolean)
    writer = {
      ref: writerRef,
      sha: null,
      configuredSha: null,
      refSha: null,
      compareStatus: null,
      resolved: false,
      conflict: false,
      invalid: false,
      readError: true,
      reason: `Cannot read Production Writer variables from ${repository}: ${details.join('; ') || 'GitHub API error'}.`,
    }
  } else if (production && (writerRef || writerShaVariable)) {
    const configuredSha = writerShaVariable ? writerShaVariable.toLowerCase() : null
    const shaValid = configuredSha === null || HEX_40_RE.test(configuredSha)
    const identity = writerRef
      ? (releaseSource.ok
        ? readRemoteReleaseIdentity({ repository: releaseSource.repository, tag: writerRef, spawnSyncImpl })
        : { ok: false, reason: `Cannot resolve ${writerRef} without a verified release source.` })
      : null
    const refSha = identity?.ok ? identity.sha : null
    const conflict = Boolean(shaValid && configuredSha && refSha && configuredSha !== refSha)
    const unresolvedRef = Boolean(writerRef) && refSha === null
    const reason = !shaValid
      ? `AIRINGCAL_${prefix}_RELEASE_SHA "${writerShaVariable}" is not a 40-character commit SHA.`
      : conflict
        ? `AIRINGCAL_${prefix}_RELEASE_REF ${writerRef} resolves to ${refSha.slice(0, 12)}, but AIRINGCAL_${prefix}_RELEASE_SHA records ${configuredSha.slice(0, 12)}.`
        : unresolvedRef
          ? `AIRINGCAL_${prefix}_RELEASE_REF ${writerRef} cannot be resolved${identity?.reason ? ` (${identity.reason})` : ''}.`
          : null

    let compareStatus = null
    if (!reason && !writerRef && shaValid && configuredSha && target?.sha && configuredSha !== target.sha && releaseSource.ok) {
      const cmp = ghJson(spawnSyncImpl, `repos/${releaseSource.repository}/compare/${target.sha}...${configuredSha}`)
      if (cmp && typeof cmp.status === 'string') {
        compareStatus = cmp.status
      }
    }

    writer = {
      ref: writerRef,
      sha: shaValid ? (configuredSha ?? refSha) : null,
      configuredSha: shaValid ? configuredSha : null,
      refSha,
      compareStatus,
      resolved: Boolean(shaValid && (configuredSha ?? refSha)),
      conflict,
      invalid: Boolean(reason && !conflict),
      readError: false,
      reason,
    }
  }

  const remoteOriginRes = variable(`AIRINGCAL_${prefix}_PUBLIC_BASE_URL`)
  const origin = String(
    env[`AIRINGCAL_${prefix}_PUBLIC_BASE_URL`]
    || (remoteOriginRes.kind === 'ok' ? remoteOriginRes.value : null)
    || baseUrl
    || '',
  ).trim()
  const reader = await readReaderVersion({ baseUrl: origin, fetchImpl })

  const plan = planUpdate({
    environment: environmentName,
    local,
    target,
    writer,
    reader,
    dirty: local.dirty === true,
    statusOk: local.statusOk,
  })

  return {
    environment: environmentName,
    repository,
    releaseSource,
    releaseSourceUrl: releaseSource.ok ? `https://github.com/${releaseSource.repository}.git` : null,
    releases,
    releaseError,
    local,
    localVersion: local.version,
    localTag: local.tag,
    target,
    writer,
    reader,
    readerOrigin: origin || null,
    plan,
  }
}