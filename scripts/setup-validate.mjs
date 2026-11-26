/**
 * #205 UX-005: shared credential validation serving both the standalone menu
 * action and the inline installation flow. Read-only provider APIs only; states
 * are explicit (VERIFIED / MISSING / NOT_VERIFIED / NOT_APPLICABLE) and a
 * successful list does NOT imply write permission.
 */

import {
  IdentityError,
  fetchCloudflareAccounts,
  fetchWorkersSubdomain,
  resolveBangumiIdentity,
  verifyCloudflareToken,
} from './setup-identities.mjs'

const CF_API = 'https://api.cloudflare.com/client/v4'

export const VALIDATION_STATES = Object.freeze(['VERIFIED', 'MISSING', 'NOT_VERIFIED', 'NOT_APPLICABLE'])

function check(id, label, state, detail = null) {
  return { id, label, state, detail }
}

async function cfRead(fetchImpl, token, path) {
  const response = await fetchImpl(`${CF_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok && body?.success !== false, status: response.status, body }
}

/** Capability probes are read-only; write abilities stay NOT_VERIFIED. */
async function probeCloudflareCapabilities({ fetchImpl, token, accountId }) {
  const checks = []
  const account = encodeURIComponent(accountId)

  const workers = await cfRead(fetchImpl, token, `/accounts/${account}/workers/scripts`).catch((error) => ({ ok: false, error }))
  checks.push(workers.ok
    ? check('workers.read', 'Workers scripts read', 'VERIFIED')
    : check('workers.read', 'Workers scripts read', 'MISSING', `HTTP ${workers.status ?? workers.error?.message ?? 'error'}`))

  const buckets = await cfRead(fetchImpl, token, `/accounts/${account}/r2/buckets`).catch((error) => ({ ok: false, error }))
  checks.push(buckets.ok
    ? check('r2.read', 'R2 buckets read', 'VERIFIED')
    : check('r2.read', 'R2 buckets read', 'MISSING', `HTTP ${buckets.status ?? buckets.error?.message ?? 'error'}`))

  let tokenCreation = 'NOT_VERIFIED'
  let creationDetail = null
  try {
    const perms = await cfRead(fetchImpl, token, '/user/tokens/permissions')
    const entries = Array.isArray(perms.body?.result?.permissions) ? perms.body.result.permissions : []
    const text = entries.map((entry) => (typeof entry === 'string' ? entry : `${entry?.name ?? ''} ${entry?.description ?? ''}`)).join(' ')
    if (/api[ -]?tokens?/i.test(text) && /edit|create|write/i.test(text)) tokenCreation = 'VERIFIED'
    else if (perms.ok && text.length > 0) {
      tokenCreation = 'MISSING'
      creationDetail = 'permission catalogue shows no User API Tokens edit/create'
    } else creationDetail = 'permission catalogue unavailable'
  } catch (error) {
    creationDetail = error.message
  }
  checks.push(check('writer.provision', 'Independent Writer token provisioning', tokenCreation, creationDetail))
  checks.push(check('r2.write', 'R2 object write', 'NOT_VERIFIED',
    'write capability is proven only by the authorized apply (no undisclosed mutation here)'))
  return checks
}

async function probeBangumiCapabilities({ fetchImpl, token }) {
  const identity = await resolveBangumiIdentity(fetchImpl, token)
  const checks = [check('bangumi.identity', 'Bangumi identity', 'VERIFIED', `${identity.username} (id ${identity.userId})`)]
  try {
    const response = await fetchImpl(
      `https://api.bgm.tv/v0/users/${encodeURIComponent(identity.username)}/collections?subject_type=2&limit=1&offset=0`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)',
        },
        signal: AbortSignal.timeout(15_000),
      },
    )
    const body = await response.json().catch(() => null)
    const ok = response.ok && Number.isSafeInteger(body?.total)
    checks.push(ok
      ? check('bangumi.collections', 'Anime collection read', 'VERIFIED', `total ${body.total}`)
      : check('bangumi.collections', 'Anime collection read', 'MISSING', `HTTP ${response.status}`))
    const subjectId = Array.isArray(body?.data) && body.data[0]?.subject_id
    if (subjectId) {
      const episodes = await fetchImpl(`https://api.bgm.tv/v0/users/-/collections/${subjectId}/episodes?limit=1&offset=0`, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)',
        },
        signal: AbortSignal.timeout(15_000),
      })
      checks.push(episodes.ok
        ? check('bangumi.episodes', 'Episode progress read', 'VERIFIED')
        : check('bangumi.episodes', 'Episode progress read', 'MISSING', `HTTP ${episodes.status}`))
    } else {
      checks.push(check('bangumi.episodes', 'Episode progress read', 'NOT_APPLICABLE', 'no collected anime subject to probe'))
    }
  } catch (error) {
    checks.push(check('bangumi.collections', 'Anime collection read', 'NOT_VERIFIED', error.message?.slice(0, 200)))
    checks.push(check('bangumi.episodes', 'Episode progress read', 'NOT_VERIFIED', 'identity unavailable'))
  }
  return { identity, checks }
}

/**
 * Validate credentials without creating or modifying anything.
 * Returns per-check states plus a blocking verdict for mandatory checks.
 */
export async function validateCredentials({
  fetchImpl = globalThis.fetch,
  cloudflareToken,
  bangumiToken,
  s3 = null,
  customDomain = false,
  edgeone = false,
  objectStoreFactory = null,
  log = () => {},
} = {}) {
  const checks = []
  let identity = null
  let account = null
  let workersSubdomain = null

  // Cloudflare: token validity is NOT the same as effective authorization.
  try {
    if (!String(cloudflareToken ?? '').trim()) {
      checks.push(check('cloudflare.token', 'Cloudflare API Token', 'MISSING', 'no token supplied'))
    } else {
      const verified = await verifyCloudflareToken(fetchImpl, cloudflareToken)
      checks.push(check('cloudflare.token', 'Cloudflare API Token', 'VERIFIED', `token ${verified.status}`))
      const accounts = await fetchCloudflareAccounts(fetchImpl, cloudflareToken, { secrets: [cloudflareToken] })
      checks.push(check('cloudflare.accounts', 'Cloudflare account discovery', accounts.length === 1 ? 'VERIFIED' : 'VERIFIED',
        accounts.length === 1 ? accounts[0].name : `${accounts.length} eligible accounts`))
      if (accounts.length === 1) {
        account = accounts[0]
        workersSubdomain = await fetchWorkersSubdomain(fetchImpl, cloudflareToken, account.id, { secrets: [cloudflareToken] })
        checks.push(check('cloudflare.subdomain', 'workers.dev subdomain', 'VERIFIED', workersSubdomain))
        checks.push(...await probeCloudflareCapabilities({ fetchImpl, token: cloudflareToken, accountId: account.id }))
      } else {
        checks.push(check('cloudflare.subdomain', 'workers.dev subdomain', 'NOT_VERIFIED', 'select an account first'))
      }
    }
  } catch (error) {
    const code = error instanceof IdentityError ? error.code : 'CF_ERROR'
    checks.push(check('cloudflare.token', 'Cloudflare API Token', code === 'CF_UNAUTHORIZED' ? 'MISSING' : 'NOT_VERIFIED',
      error.message?.slice(0, 240)))
  }
  checks.push(check('cloudflare.customDomain', 'Custom Domain permissions', customDomain ? 'NOT_VERIFIED' : 'NOT_APPLICABLE',
    customDomain ? 'verified only when binding the chosen hostname' : 'Custom Domain not selected'))
  checks.push(check('edgeone', 'EdgeOne provider', edgeone ? 'NOT_VERIFIED' : 'NOT_APPLICABLE',
    edgeone ? 'EdgeOne token required only when enabled' : 'EdgeOne disabled (default)'))

  // Bangumi PAT.
  try {
    if (!String(bangumiToken ?? '').trim()) {
      checks.push(check('bangumi.token', 'Bangumi Personal Access Token', 'MISSING', 'no token supplied'))
    } else {
      const result = await probeBangumiCapabilities({ fetchImpl, token: bangumiToken })
      identity = result.identity
      checks.push(check('bangumi.token', 'Bangumi Personal Access Token', 'VERIFIED', `id ${result.identity.userId}`))
      checks.push(...result.checks)
    }
  } catch (error) {
    const code = error instanceof IdentityError ? error.code : 'BGM_ERROR'
    checks.push(check('bangumi.token', 'Bangumi Personal Access Token', 'MISSING', error.message?.slice(0, 240)))
    checks.push(check('bangumi.collections', 'Anime collection read', 'MISSING', `token rejected (${code})`))
  }

  // Independent S3 override (when supplied).
  if (s3?.accessKeyId && s3?.secretAccessKey && objectStoreFactory) {
    try {
      const store = objectStoreFactory(s3)
      await store.list('')
      store.close?.()
      checks.push(check('writer.s3', 'Independent R2 S3 credential', 'VERIFIED', 'list succeeded'))
    } catch (error) {
      checks.push(check('writer.s3', 'Independent R2 S3 credential', 'MISSING', String(error?.message ?? error).slice(0, 200)))
    }
  } else {
    checks.push(check('writer.s3', 'Independent R2 S3 credential', 'NOT_APPLICABLE',
      'not supplied; automatic scoped provisioning is attempted during apply'))
  }

  const mandatory = ['cloudflare.token', 'cloudflare.accounts', 'bangumi.token', 'bangumi.collections']
  const failures = checks.filter((entry) => mandatory.includes(entry.id) && entry.state !== 'VERIFIED')
  const blocking = failures.map((entry) => entry.id)
  for (const entry of checks) log(`${entry.state.padEnd(14)} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)
  return { ok: blocking.length === 0, checks, blocking, identity, account, workersSubdomain }
}
