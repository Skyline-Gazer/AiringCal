/**
 * Identity discovery for `pnpm setup` (#195 P1): Cloudflare accounts,
 * workers.dev subdomain, zones, DNS occupancy and Bangumi PAT identity.
 *
 * All functions are pure over an injectable `fetchImpl` and never mutate
 * remote state. Errors carry a stable `code` so the wizard can branch on
 * provider outcomes instead of matching English text.
 */

const CF_API = 'https://api.cloudflare.com/client/v4'
const BGM_API_BASE = 'https://api.bgm.tv'
const BGM_USER_AGENT = 'markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)'

export class IdentityError extends Error {
  constructor(code, message, { status, detail } = {}) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
    if (status !== undefined) this.status = status
    if (detail !== undefined) this.detail = detail
  }
}

function redact(text, secrets = []) {
  let out = String(text ?? '')
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('<redacted>')
  }
  return out
}

async function cfGet(fetchImpl, token, path, { secrets = [] } = {}) {
  let response
  try {
    response = await fetchImpl(`${CF_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdentityError('CF_NETWORK', `Cloudflare API unreachable (${path}): ${redact(error.message, secrets)}`)
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    const code = response.status === 401 || response.status === 403 ? 'CF_UNAUTHORIZED' : 'CF_API_ERROR'
    const detail = Array.isArray(body.errors) && body.errors.length > 0
      ? body.errors.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ')
      : `HTTP ${response.status}`
    throw new IdentityError(code, `Cloudflare API ${path} failed: ${redact(detail, secrets)}`, {
      status: response.status,
      detail,
    })
  }
  return body.result
}

/** `GET /user/tokens/verify` — distinguishes an invalid/disabled token early. */
export async function verifyCloudflareToken(fetchImpl, token) {
  const result = await cfGet(fetchImpl, token, '/user/tokens/verify', { secrets: [token] })
  const status = String(result?.status ?? '')
  if (status !== 'active') {
    throw new IdentityError('CF_TOKEN_INACTIVE', `Cloudflare token status is "${status || 'unknown'}" (expected active)`)
  }
  return { status, tokenId: String(result?.id ?? '') || null }
}

/** `GET /accounts` — exactly-one auto-selects; multiple return all for the prompt. */
export async function fetchCloudflareAccounts(fetchImpl, token, { secrets = [token] } = {}) {
  const result = await cfGet(fetchImpl, token, '/accounts', { secrets })
  if (!Array.isArray(result)) {
    throw new IdentityError('CF_BAD_RESPONSE', 'Cloudflare /accounts did not return an array')
  }
  const accounts = result
    .filter((entry) => typeof entry?.id === 'string' && /^[0-9a-f]{32}$/i.test(entry.id))
    .map((entry) => ({ id: entry.id, name: String(entry?.name ?? entry.id) }))
  if (accounts.length === 0) {
    throw new IdentityError('CF_NO_ACCOUNTS', 'Cloudflare token can see no eligible account (needs Account R2/Workers read)')
  }
  return accounts
}

/** `GET /accounts/{id}/workers/subdomain` — real origin host, never guessed. */
export async function fetchWorkersSubdomain(fetchImpl, token, accountId, { secrets = [token] } = {}) {
  const result = await cfGet(fetchImpl, token, `/accounts/${accountId}/workers/subdomain`, { secrets })
  const subdomain = String(result?.subdomain ?? '').trim()
  if (!subdomain || !/^[a-z0-9-]+$/i.test(subdomain)) {
    throw new IdentityError('CF_NO_WORKERS_SUBDOMAIN', 'Cloudflare account has no workers.dev subdomain')
  }
  return subdomain
}

/** `GET /zones?account.id=` — only zones owned by the discovered account. */
export async function fetchZones(fetchImpl, token, accountId, { secrets = [token] } = {}) {
  const zones = []
  let page = 1
  for (;;) {
    const body = await cfGet(fetchImpl, token, `/zones?account.id=${encodeURIComponent(accountId)}&page=${page}&per_page=50`, { secrets })
    // cfGet returns `result`; zone listings carry pagination in `result_info`,
    // which the caller reads from a second request — keep it simple: stop when
    // a page returns fewer than 50 zones.
    if (!Array.isArray(body)) throw new IdentityError('CF_BAD_RESPONSE', 'Cloudflare /zones did not return an array')
    for (const zone of body) {
      if (typeof zone?.id === 'string' && typeof zone?.name === 'string') {
        zones.push({ id: zone.id, name: zone.name, status: String(zone.status ?? '') })
      }
    }
    if (body.length < 50) break
    page += 1
    if (page > 20) break
  }
  return zones
}

/** DNS occupancy probe: an existing record means takeover, never overwrite. */
export async function fetchDnsRecordsForName(fetchImpl, token, zoneId, hostname, { secrets = [token] } = {}) {
  const result = await cfGet(fetchImpl, token, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`, { secrets })
  if (!Array.isArray(result)) throw new IdentityError('CF_BAD_RESPONSE', 'Cloudflare DNS listing did not return an array')
  return result
    .filter((record) => typeof record?.name === 'string' && record.name.toLowerCase() === hostname.toLowerCase())
    .map((record) => ({ id: String(record.id ?? ''), type: String(record.type ?? ''), content: String(record.content ?? '') }))
}

/**
 * `GET /v0/me` with the PAT — the only trustworthy source for the identity
 * used to derive `USERS_JSON`. Actionable diagnostics for bad/expired PATs.
 */
export async function resolveBangumiIdentity(fetchImpl, token, { apiBase = BGM_API_BASE } = {}) {
  let response
  try {
    response = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/v0/me`, {
      headers: {
        'User-Agent': BGM_USER_AGENT,
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw new IdentityError('BGM_NETWORK', `Bangumi API unreachable: ${redact(error.message, [token])}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new IdentityError(
      'BGM_PAT_REJECTED',
      'Bangumi rejected the personal access token (401/403). Create a new PAT at https://next.bgm.tv/demo/access-token and retry.',
      { status: response.status },
    )
  }
  if (!response.ok) {
    throw new IdentityError('BGM_API_ERROR', `Bangumi /v0/me failed: HTTP ${response.status}`, { status: response.status })
  }
  const body = await response.json().catch(() => null)
  const id = body?.id
  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  if (!Number.isSafeInteger(id) || id <= 0 || !username) {
    throw new IdentityError('BGM_BAD_RESPONSE', 'Bangumi /v0/me did not return an integer id and username')
  }
  return { userId: String(id), username }
}

/**
 * Derive the internal single-user configuration exactly as the Writer reads
 * it (`apps/node-jobs/src/sync/config.ts`): a JSON array of {userId, username}
 * with the primary id present in the list.
 */
export function deriveUsersConfig(identity, { extraUsers = [] } = {}) {
  const users = [{ userId: identity.userId, username: identity.username }, ...extraUsers]
  const seen = new Set()
  for (const user of users) {
    if (!user?.userId || !user?.username) {
      throw new IdentityError('USERS_CONFIG_INVALID', 'Each user needs a non-empty userId and username')
    }
    if (seen.has(user.userId)) throw new IdentityError('USERS_CONFIG_INVALID', `Duplicate userId ${user.userId}`)
    seen.add(user.userId)
  }
  if (!seen.has(identity.userId)) throw new IdentityError('USERS_CONFIG_INVALID', 'Primary user missing from the list')
  return JSON.stringify(users)
}
