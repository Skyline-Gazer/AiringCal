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
  accountId = null,
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
      checks.push(check('cloudflare.accounts', 'Cloudflare account discovery', 'VERIFIED',
        accounts.length === 1 ? accounts[0].name : `${accounts.length} eligible accounts`))
      const selected = accountId
        ? accounts.find((entry) => entry.id.toLowerCase() === String(accountId).toLowerCase()) ?? null
        : (accounts.length === 1 ? accounts[0] : null)
      if (selected) {
        account = selected
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

/**
 * #208 UX-010: user-facing credential validation summary.
 * Never converts NOT_VERIFIED into VERIFIED; explains confirmed capabilities,
 * missing mandatory capabilities, unverified write/provisioning steps, and
 * expected fallback requirements in clear operator language.
 */
export function summarizeValidation(validation) {
  const checks = Array.isArray(validation?.checks) ? validation.checks : []
  const byId = (id) => checks.find((entry) => entry.id === id) ?? null
  const confirmed = []
  const missing = []
  const unverified = []

  const cfToken = byId('cloudflare.token')
  const cfAccounts = byId('cloudflare.accounts')
  const cfSubdomain = byId('cloudflare.subdomain')
  const workersRead = byId('workers.read')
  const r2Read = byId('r2.read')
  const writerProv = byId('writer.provision')
  const r2Write = byId('r2.write')
  const bgmToken = byId('bangumi.token')
  const bgmCollections = byId('bangumi.collections')
  const bgmEpisodes = byId('bangumi.episodes')
  const s3Override = byId('writer.s3')

  if (cfToken?.state === 'VERIFIED') confirmed.push('Cloudflare API Token is valid.')
  else if (cfToken) missing.push(`Cloudflare API Token: ${cfToken.detail ?? cfToken.state}.`)

  if (cfAccounts?.state === 'VERIFIED') {
    confirmed.push(`Cloudflare account discovery succeeded (${cfAccounts.detail ?? 'verified'}).`)
  } else if (cfAccounts && cfAccounts.state !== 'NOT_APPLICABLE') {
    missing.push(`Cloudflare account discovery failed: ${cfAccounts.detail ?? cfAccounts.state}.`)
  }

  if (cfSubdomain?.state === 'VERIFIED') {
    confirmed.push(`workers.dev subdomain resolved (${cfSubdomain.detail}).`)
  }
  if (workersRead?.state === 'VERIFIED') confirmed.push('Workers scripts read permission verified.')
  else if (workersRead?.state === 'MISSING') {
    unverified.push(`Workers scripts read returned ${workersRead.detail ?? 'missing'} (write permission will be tested at apply).`)
  }

  if (r2Read?.state === 'VERIFIED') confirmed.push('R2 buckets read permission verified.')
  else if (r2Read?.state === 'MISSING') {
    unverified.push(`R2 buckets read returned ${r2Read.detail ?? 'missing'} (write permission will be tested at apply).`)
  }

  if (bgmToken?.state === 'VERIFIED' && bgmCollections?.state === 'VERIFIED') {
    confirmed.push(`Bangumi PAT and anime collection access verified (${bgmCollections.detail ?? 'ok'}).`)
  } else {
    if (bgmToken && bgmToken.state !== 'VERIFIED') {
      missing.push(`Bangumi Personal Access Token failed: ${bgmToken.detail ?? bgmToken.state}.`)
    }
    if (bgmCollections && bgmCollections.state !== 'VERIFIED') {
      missing.push(`Bangumi anime collection read failed: ${bgmCollections.detail ?? bgmCollections.state}.`)
    }
  }

  if (bgmEpisodes?.state === 'VERIFIED') {
    confirmed.push('Bangumi episode progress read verified.')
  } else if (bgmEpisodes && bgmEpisodes.state !== 'NOT_APPLICABLE' && bgmEpisodes.state !== 'VERIFIED') {
    unverified.push(`Bangumi episode progress read is ${bgmEpisodes.state} (${bgmEpisodes.detail ?? 'unverified'}).`)
  }

  let fallbackNote = null
  if (writerProv?.state === 'VERIFIED') {
    confirmed.push('Cloudflare token permission catalogue shows API Token Edit capability.')
  } else if (writerProv?.state === 'MISSING') {
    unverified.push('Automatic Writer token creation is not listed in the token permission catalogue.')
    fallbackNote = 'Deployment may require an independently scoped R2 S3 credential (masked fallback prompt is available during installation).'
  } else if (writerProv?.state === 'NOT_VERIFIED') {
    unverified.push(`Automatic Writer credential creation could not be verified read-only (${writerProv.detail ?? 'catalogue unavailable'}).`)
    fallbackNote = 'Deployment will attempt automatic bucket-scoped Writer provisioning and offer a masked R2 S3 fallback if unavailable.'
  }

  if (r2Write?.state === 'NOT_VERIFIED') {
    unverified.push('Write permissions (bucket, Worker deploy, GitHub Environment) are NOT tested read-only and will be confirmed during authorized installation.')
  }
  if (s3Override?.state === 'VERIFIED') {
    confirmed.push('Supplied independent R2 S3 credential passed read-only list check.')
  } else if (s3Override?.state === 'MISSING') {
    missing.push(`Supplied independent R2 S3 credential failed: ${s3Override.detail ?? 'rejected'}.`)
  }

  const blocked = !validation?.ok
  const status = blocked ? 'blocked' : (fallbackNote ? 'ready-with-notes' : 'ready')
  const headline = blocked
    ? 'Credentials are missing mandatory access — fix the blocking items below before installing.'
    : fallbackNote
      ? 'Mandatory read-only checks passed; installation can continue (independent R2 credential fallback may be needed).'
      : 'Mandatory read-only checks passed; ready to continue to installation.'
  const nextAction = blocked
    ? 'Re-enter the failing token(s) or fix their permissions, then revalidate.'
    : 'Choose "Continue to Installation" to reuse these validated credentials in this session.'

  return { status, headline, confirmed, missing, unverified, fallbackNote, nextAction }
}

export function formatValidationSummary(validation) {
  const summary = summarizeValidation(validation)
  const lines = [summary.headline, '']
  if (summary.confirmed.length > 0) {
    lines.push('Confirmed:')
    for (const item of summary.confirmed) lines.push(`  ✓ ${item}`)
  }
  if (summary.missing.length > 0) {
    lines.push('Missing mandatory capabilities (blocking):')
    for (const item of summary.missing) lines.push(`  ✗ ${item}`)
  }
  if (summary.unverified.length > 0) {
    lines.push('Not verified read-only:')
    for (const item of summary.unverified) lines.push(`  ! ${item}`)
  }
  if (summary.fallbackNote) {
    lines.push(`Fallback note: ${summary.fallbackNote}`)
  }
  lines.push(`Next: ${summary.nextAction}`)
  return lines.join('\n')
}

export function formatValidationDetails(validation) {
  const checks = Array.isArray(validation?.checks) ? validation.checks : []
  return checks
    .map((entry) => `${String(entry.state).padEnd(14)} ${entry.label}${entry.detail ? ` — ${entry.detail}` : ''}`)
    .join('\n')
}
