/**
 * #208 QA-002: Stateful Controlled Provider Simulator for real Live I/O Adapter
 * integration tests.
 *
 * Replaces ONLY the lowest external transport/process boundaries (`fetchImpl`,
 * `spawnSyncImpl`, `createObjectStore`) so tests execute the real
 * `runProductionApply`, real `createLiveDevelopmentApplyIo`, real credential
 * state management, real mutation ledger, and real wizard orchestration.
 */

import { createHash } from 'node:crypto'
import { spawnSync as realSpawnSync } from 'node:child_process'

export const DEFAULT_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
export const SECONDARY_ACCOUNT_ID = 'fedcba9876543210fedcba9876543210'

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function makeHttpError(message, status, code = undefined) {
  const err = new Error(message)
  if (status) err.$metadata = { httpStatusCode: status }
  if (code) err.Code = code
  return err
}

function parseS3AccountId(endpoint) {
  const match = String(endpoint ?? '').match(/^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com/i)
  return match ? match[1].toLowerCase() : null
}

function parseWranglerEnv(options = {}) {
  const env = options.env ?? {}
  return {
    token: String(env.CLOUDFLARE_API_TOKEN ?? '').trim(),
    accountId: String(env.CLOUDFLARE_ACCOUNT_ID ?? '').trim().toLowerCase(),
  }
}

export function createControlledProviderSimulator({
  primaryAccountId = DEFAULT_ACCOUNT_ID,
  primaryAccountName = 'Primary Synthetic Account',
  primarySubdomain = 'primary-sim',
  managementToken = 'cf-mgmt-sim-token',
  bangumiToken = 'bgm-pat-sim-token',
  bangumiUser = { id: 901234, username: 'sim-owner' },
  extraAccounts = [],
  accessibleAccountIds = null,
  seedUnrelatedBuckets = true,
  gitSha = 'a'.repeat(40),
  faults = {},
} = {}) {
  const state = {
    accounts: new Map(),
    managementTokens: new Map(),
    mintedTokens: new Map(),
    deletedTokens: [],
    operatorS3Overrides: new Map(),
    github: {
      environments: new Map(),
      workflows: new Map([['portable-writer.yml', { id: 407881922, state: 'disabled_manually' }]]),
      repoVariables: new Map(),
    },
    calls: {
      http: [],
      spawn: [],
      s3: [],
    },
    faults: { ...faults },
  }

  let tokenSeq = 0

  function ensureAccount(id, name, subdomain) {
    const normalized = String(id).toLowerCase()
    if (!state.accounts.has(normalized)) {
      state.accounts.set(normalized, {
        id: normalized,
        name,
        subdomain,
        buckets: new Map(),
        workers: new Map(),
        zones: new Map(),
      })
    }
    return state.accounts.get(normalized)
  }

  const primary = ensureAccount(primaryAccountId, primaryAccountName, primarySubdomain)
  if (seedUnrelatedBuckets) {
    primary.buckets.set('unrelated-blog-assets', {
      name: 'unrelated-blog-assets',
      creationDate: '2025-01-10T00:00:00.000Z',
      location: 'APAC',
      r2DevEnabled: true,
      objects: new Map([
        ['index.html', { body: new TextEncoder().encode('<h1>blog</h1>'), contentType: 'text/html', etag: 'etag-blog-1' }],
      ]),
    })
    primary.buckets.set('unrelated-archive', {
      name: 'unrelated-archive',
      creationDate: '2025-03-15T00:00:00.000Z',
      location: 'WNAM',
      r2DevEnabled: false,
      objects: new Map([
        ['archive.json', { body: new TextEncoder().encode('{"ok":true}'), contentType: 'application/json', etag: 'etag-arch-1' }],
      ]),
    })
  }

  for (const acct of extraAccounts) {
    ensureAccount(acct.id, acct.name ?? `Account ${acct.id.slice(0, 6)}`, acct.subdomain ?? 'extra-sim')
  }

  const allowedAccounts = accessibleAccountIds
    ? accessibleAccountIds.map((id) => String(id).toLowerCase())
    : [String(primaryAccountId).toLowerCase(), ...extraAccounts.map((a) => String(a.id).toLowerCase())]

  state.managementTokens.set(managementToken, {
    id: 'mgmt-token-id-1',
    status: 'active',
    accountIds: allowedAccounts,
    r2Read: true,
    r2Write: true,
    workersRead: true,
    workersWrite: true,
    canCreateTokens: true,
  })

  function findAccount(accountId) {
    return state.accounts.get(String(accountId ?? '').toLowerCase()) ?? null
  }

  function getMgmtToken(token) {
    return state.managementTokens.get(String(token ?? '').trim()) ?? null
  }

  function seedBucket(accountId, bucketName, { objects = {}, r2DevEnabled = true, creationDate = '2026-11-26T10:36:40.000Z', location = 'APAC' } = {}) {
    const acct = findAccount(accountId)
    if (!acct) throw new Error(`Unknown simulator account: ${accountId}`)
    const objMap = new Map()
    for (const [k, v] of Object.entries(objects)) {
      const bytes = v instanceof Uint8Array ? v : new TextEncoder().encode(String(v))
      objMap.set(k, { body: bytes, contentType: 'application/octet-stream', etag: sha256Hex(k).slice(0, 16) })
    }
    acct.buckets.set(bucketName, {
      name: bucketName,
      creationDate,
      location,
      r2DevEnabled,
      objects: objMap,
    })
  }

  function addOperatorS3Override({ accessKeyId, secretAccessKey, allowedBuckets = null }) {
    state.operatorS3Overrides.set(String(accessKeyId), {
      accessKeyId: String(accessKeyId),
      secretAccessKey: String(secretAccessKey),
      allowedBuckets: allowedBuckets ? [...allowedBuckets] : null,
    })
  }

  function seedMintedToken({ id, name, value, policies }) {
    state.mintedTokens.set(id, { id, name, value, policies, status: 'active' })
  }

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
    }
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(String(url))
    const method = String(init.method ?? 'GET').toUpperCase()
    const auth = String(init.headers?.Authorization ?? init.headers?.authorization ?? '')
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    state.calls.http.push({ method, host: u.host, pathname: u.pathname, search: u.search })

    // 1. Cloudflare API
    if (u.host === 'api.cloudflare.com') {
      const path = u.pathname.replace(/^\/client\/v4/, '')

      if (method === 'GET' && path === '/user/tokens/verify') {
        const mgmt = getMgmtToken(bearer)
        if (mgmt) return jsonResponse(200, { success: true, result: { id: mgmt.id, status: mgmt.status } })
        const minted = [...state.mintedTokens.values()].find((t) => t.value === bearer)
        if (minted) {
          if (state.faults.tokenVerifyMismatch) {
            return jsonResponse(200, { success: true, result: { id: 'wrong-token-id', status: 'active' } })
          }
          return jsonResponse(200, { success: true, result: { id: minted.id, status: minted.status } })
        }
        return jsonResponse(401, { success: false, errors: [{ code: 10000, message: 'Invalid token' }] })
      }

      const mgmt = getMgmtToken(bearer)
      if (!mgmt) {
        return jsonResponse(401, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
      }

      if (method === 'GET' && path === '/accounts') {
        const list = mgmt.accountIds
          .map((id) => findAccount(id))
          .filter(Boolean)
          .map((a) => ({ id: a.id, name: a.name }))
        return jsonResponse(200, { success: true, result: list })
      }

      const subdomainMatch = path.match(/^\/accounts\/([^/]+)\/workers\/subdomain$/)
      if (method === 'GET' && subdomainMatch) {
        const acct = findAccount(decodeURIComponent(subdomainMatch[1]))
        if (!acct || !mgmt.accountIds.includes(acct.id)) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Account not accessible' }] })
        }
        return jsonResponse(200, { success: true, result: { subdomain: acct.subdomain } })
      }

      const scriptsMatch = path.match(/^\/accounts\/([^/]+)\/workers\/scripts$/)
      if (method === 'GET' && scriptsMatch) {
        const acct = findAccount(decodeURIComponent(scriptsMatch[1]))
        if (!acct || !mgmt.accountIds.includes(acct.id) || !mgmt.workersRead) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Unauthorized' }] })
        }
        return jsonResponse(200, {
          success: true,
          result: [...acct.workers.values()].map((w) => ({ id: w.name })),
        })
      }

      const bucketsMatch = path.match(/^\/accounts\/([^/]+)\/r2\/buckets$/)
      if (method === 'GET' && bucketsMatch) {
        const acct = findAccount(decodeURIComponent(bucketsMatch[1]))
        if (!acct || !mgmt.accountIds.includes(acct.id) || !mgmt.r2Read) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Unauthorized' }] })
        }
        return jsonResponse(200, {
          success: true,
          result: {
            buckets: [...acct.buckets.values()].map((b) => ({
              name: b.name,
              creation_date: b.creationDate,
              location: b.location,
            })),
          },
        })
      }

      if (method === 'GET' && path === '/zones') {
        const acctId = String(u.searchParams.get('account.id') ?? '').toLowerCase()
        const acct = findAccount(acctId)
        if (!acct || !mgmt.accountIds.includes(acct.id)) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Unauthorized' }] })
        }
        return jsonResponse(200, { success: true, result: [...acct.zones.values()] })
      }

      if (method === 'GET' && path === '/user/tokens/permissions') {
        const mode = state.faults.permissionsMode ?? 'allowed'
        if (mode === 'network-error') throw new TypeError('fetch failed: connection reset')
        if (mode === 'server-error') return jsonResponse(500, { success: false, errors: [{ code: 500, message: 'Internal Error' }] })
        if (mode === 'forbidden') return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Forbidden' }] })
        if (mode === 'denied') return jsonResponse(200, { success: true, result: { permissions: ['Workers R2 Storage:Read'] } })
        if (mode === 'empty') return jsonResponse(200, { success: true, result: { permissions: [] } })
        if (mode === 'unrecognized') return jsonResponse(200, { success: true, result: { permissions: ['DNS:Read'] } })
        return jsonResponse(200, { success: true, result: { permissions: ['User API Tokens:Edit'] } })
      }

      if (method === 'GET' && path === '/user/tokens/permission_groups') {
        if (state.faults.permissionGroupMissing) {
          return jsonResponse(200, { success: true, result: [] })
        }
        return jsonResponse(200, {
          success: true,
          result: [
            { id: 'pg-r2-item-write', name: 'Workers R2 Storage Bucket Item Write' },
            { id: 'pg-r2-item-read', name: 'Workers R2 Storage Bucket Item Read' },
          ],
        })
      }

      if (method === 'GET' && path === '/user/tokens') {
        if (state.faults.tokenListForbidden) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Forbidden' }] })
        }
        return jsonResponse(200, {
          success: true,
          result: [...state.mintedTokens.values()].map((t) => ({ id: t.id, name: t.name, status: t.status })),
        })
      }

      if (method === 'POST' && path === '/user/tokens') {
        if (state.faults.tokenCreateStatus) {
          return jsonResponse(state.faults.tokenCreateStatus, {
            success: false,
            errors: [{ code: 10000, message: 'Authentication error / denied' }],
          })
        }
        if (!mgmt.canCreateTokens) {
          return jsonResponse(403, { success: false, errors: [{ code: 10000, message: 'Token lacks User API Tokens:Edit' }] })
        }
        const payload = JSON.parse(String(init.body ?? '{}'))
        const policies = Array.isArray(payload.policies) ? payload.policies : []
        // Enforce realistic provider precondition: bucket-scoped R2 resource keys require an existing bucket!
        for (const policy of policies) {
          for (const resourceKey of Object.keys(policy?.resources ?? {})) {
            const match = resourceKey.match(/^com\.cloudflare\.edge\.r2\.bucket\.([0-9a-f]{32})_default_([a-z0-9-]+)$/i)
            if (match) {
              const acct = findAccount(match[1])
              if (!acct || !acct.buckets.has(match[2])) {
                return jsonResponse(400, {
                  success: false,
                  errors: [{ code: 10000, message: `R2 bucket "${match[2]}" does not exist in account ${match[1]}` }],
                })
              }
            }
          }
        }
        tokenSeq += 1
        const id = `sim-writer-tok-${tokenSeq}`
        const value = `sim-writer-secret-val-${tokenSeq}`
        const storedPolicies = state.faults.broadTokenScope
          ? [{ effect: 'allow', resources: { 'com.cloudflare.edge.r2.bucket.*': '*' }, permission_groups: [{ id: 'pg-r2-item-write' }] }]
          : policies
        state.mintedTokens.set(id, {
          id,
          name: payload.name,
          value,
          policies: storedPolicies,
          status: 'active',
        })
        if (state.faults.tokenCreateLostResponse) {
          const err = new Error('network timeout waiting for POST /user/tokens response')
          err.code = 'ETIMEDOUT'
          throw err
        }
        return jsonResponse(200, {
          success: true,
          result: { id, name: payload.name, value, policies: storedPolicies },
        })
      }

      const tokenIdMatch = path.match(/^\/user\/tokens\/([^/]+)$/)
      if (tokenIdMatch) {
        const id = decodeURIComponent(tokenIdMatch[1])
        if (method === 'GET') {
          if (state.faults.tokenReadbackError === 'network') {
            throw new TypeError('fetch failed reading back token')
          }
          if (state.faults.tokenReadbackError) {
            return jsonResponse(500, { success: false, errors: [{ code: 500, message: 'Token readback error' }] })
          }
          const tok = state.mintedTokens.get(id)
          if (!tok) return jsonResponse(404, { success: false, errors: [{ code: 10000, message: 'Not found' }] })
          return jsonResponse(200, { success: true, result: { id: tok.id, name: tok.name, policies: tok.policies, status: tok.status } })
        }
        if (method === 'DELETE') {
          if (state.faults.tokenCleanupFail) {
            return jsonResponse(500, { success: false, errors: [{ code: 500, message: 'Delete failed' }] })
          }
          const existed = state.mintedTokens.delete(id)
          if (!existed) return jsonResponse(404, { success: false, errors: [{ code: 10000, message: 'Not found' }] })
          state.deletedTokens.push(id)
          return jsonResponse(200, { success: true, result: { id } })
        }
      }

      return jsonResponse(404, { success: false, errors: [{ code: 10000, message: `Unhandled CF path ${path}` }] })
    }

    // 2. Bangumi API
    if (u.host === 'api.bgm.tv') {
      if (bearer !== bangumiToken) return jsonResponse(401, { title: 'Unauthorized' })
      if (u.pathname === '/v0/me') return jsonResponse(200, bangumiUser)
      if (u.pathname.includes('/collections') && u.pathname.includes('/episodes')) return jsonResponse(200, { total: 1, data: [] })
      if (u.pathname.includes('/collections')) return jsonResponse(200, { total: 1, data: [{ subject_id: 900 }] })
      return jsonResponse(404, {})
    }

    // 3. Deployed Cloudflare Worker origins
    if (u.host.endsWith('.workers.dev')) {
      const parts = u.host.replace(/\.workers\.dev$/, '').split('.')
      const workerName = parts[0]
      const subdomain = parts.slice(1).join('.')
      const acct = [...state.accounts.values()].find((a) => a.subdomain === subdomain && a.workers.has(workerName))
      if (!acct) return jsonResponse(404, { error: 'Worker not deployed' })
      if (u.pathname === '/public/current-release.json') {
        const worker = acct.workers.get(workerName)
        const bucket = acct.buckets.get(worker.bucket)
        const ptr = bucket?.objects.get('public/current-release.json')
        if (!ptr) return jsonResponse(404, { error: 'No release' })
        return jsonResponse(200, JSON.parse(new TextDecoder().decode(ptr.body)))
      }
      if (u.pathname.includes('checkpoints') || u.pathname.includes('%63heckpoints')) {
        if (state.faults.isolationLeakStatus) {
          return { ok: state.faults.isolationLeakStatus < 400, status: state.faults.isolationLeakStatus, headers: { get: () => 'text/plain' }, json: async () => ({}) }
        }
        return { ok: false, status: 404, headers: { get: () => 'text/plain' }, json: async () => ({}) }
      }
      return { ok: false, status: 404, headers: { get: () => 'text/plain' }, json: async () => ({}) }
    }

    return jsonResponse(404, { error: `Unhandled host ${u.host}` })
  }

  function spawnSyncImpl(cmd, args = [], options = {}) {
    state.calls.spawn.push({ cmd, args: [...args] })

    if (cmd === 'git' && args[0] === 'rev-parse') {
      return { status: 0, stdout: `${gitSha}\n`, stderr: '', error: null }
    }

    if (cmd === 'node' && String(args[0] ?? '').endsWith('materialize-v3-read-staging-config.mjs')) {
      return realSpawnSync(cmd, args, options)
    }

    // Wrangler CLI (invoked via pnpm exec wrangler ...)
    if (cmd === 'pnpm' && args[0] === 'exec' && args[1] === 'wrangler') {
      const wArgs = args.slice(2).filter((a, i, arr) => a !== '--env-file' && arr[i - 1] !== '--env-file')
      if (wArgs[0] === '--version') {
        return { status: 0, stdout: 'wrangler 4.0.0\n', stderr: '', error: null }
      }
      const { token, accountId } = parseWranglerEnv(options)
      const mgmt = getMgmtToken(token)
      if (!mgmt) {
        return { status: 1, stdout: '', stderr: 'Authentication error: not authenticated (401)', error: null }
      }
      if (wArgs[0] === 'whoami') {
        const accounts = mgmt.accountIds.map((id) => findAccount(id)).filter(Boolean).map((a) => ({ id: a.id, name: a.name }))
        return { status: 0, stdout: JSON.stringify({ loggedIn: true, accounts }), stderr: '', error: null }
      }
      const acct = findAccount(accountId)
      if (!acct || !mgmt.accountIds.includes(acct.id)) {
        return { status: 1, stdout: '', stderr: `Authentication error: account "${accountId}" not accessible`, error: null }
      }
      if (wArgs[0] === 'r2' && wArgs[1] === 'bucket') {
        const sub = wArgs[2]
        const bucketName = wArgs[3]
        if (sub === 'list') {
          if (!mgmt.r2Read) return { status: 1, stdout: '', stderr: '403 permission denied', error: null }
          return {
            status: 0,
            stdout: [...acct.buckets.values()].map((b) => `name: ${b.name}`).join('\n'),
            stderr: '',
            error: null,
          }
        }
        if (sub === 'info') {
          if (state.faults.bucketInfoError) {
            return { status: 1, stdout: '', stderr: state.faults.bucketInfoError, error: null }
          }
          if (!mgmt.r2Read) return { status: 1, stdout: '', stderr: '403 permission denied', error: null }
          const b = acct.buckets.get(bucketName)
          if (!b) {
            return { status: 1, stdout: '', stderr: `The specified bucket does not exist (${bucketName})`, error: null }
          }
          return {
            status: 0,
            stdout: JSON.stringify({ name: b.name, creation_date: b.creationDate, location: b.location, storage_class: 'Standard' }),
            stderr: '',
            error: null,
          }
        }
        if (sub === 'create') {
          if (!mgmt.r2Write) return { status: 1, stdout: '', stderr: '403 permission denied', error: null }
          if (state.faults.bucketCreateFail) {
            return { status: 1, stdout: '', stderr: 'Cloudflare R2 create denied (403)', error: null }
          }
          if (acct.buckets.has(bucketName)) {
            return { status: 1, stdout: '', stderr: `Bucket ${bucketName} already exists`, error: null }
          }
          acct.buckets.set(bucketName, {
            name: bucketName,
            creationDate: new Date().toISOString(),
            location: 'APAC',
            r2DevEnabled: true,
            objects: new Map(),
          })
          if (state.faults.bucketCreateLostResponse) {
            return { status: 1, stdout: '', stderr: 'fetch failed: ECONNRESET after request dispatch', error: null }
          }
          return { status: 0, stdout: `Created bucket '${bucketName}'`, stderr: '', error: null }
        }
        if (sub === 'dev-url') {
          const action = wArgs[3]
          const targetBucket = wArgs[4]
          const b = acct.buckets.get(targetBucket)
          if (!b) return { status: 1, stdout: '', stderr: 'NoSuchBucket', error: null }
          if (action === 'disable') {
            if (state.faults.disableR2DevFail) return { status: 1, stdout: '', stderr: '403 cannot disable r2.dev', error: null }
            b.r2DevEnabled = false
            return { status: 0, stdout: 'Public access via the r2.dev URL is disabled.', stderr: '', error: null }
          }
          if (action === 'get') {
            return {
              status: 0,
              stdout: b.r2DevEnabled
                ? `Public access is enabled at https://pub-sim.r2.dev`
                : `Public access via the r2.dev URL is disabled.`,
              stderr: '',
              error: null,
            }
          }
        }
      }
      if (wArgs[0] === 'deploy') {
        const nameIdx = wArgs.indexOf('--name')
        const workerName = nameIdx >= 0 ? wArgs[nameIdx + 1] : 'airingcal-production'
        if (state.faults.workerDeployFail) {
          return { status: 1, stdout: '', stderr: 'wrangler deploy refused (500)', error: null }
        }
        const bucketName = workerName === 'airingcal-production' ? 'airingcal-production' : 'airingcal-development'
        acct.workers.set(workerName, { name: workerName, bucket: bucketName })
        if (state.faults.workerDeployLostResponse) {
          return { status: 1, stdout: '', stderr: 'unexpected EOF from Cloudflare deploy API', error: null }
        }
        return {
          status: 0,
          stdout: `Deployed ${workerName}\n  https://${workerName}.${acct.subdomain}.workers.dev\n`,
          stderr: '',
          error: null,
        }
      }
      return { status: 1, stdout: '', stderr: `Unhandled wrangler args: ${wArgs.join(' ')}`, error: null }
    }

    // GitHub CLI (gh)
    if (cmd === 'gh') {
      if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.60.0\n', stderr: '', error: null }
      if (args[0] === 'auth' && args[1] === 'status') return { status: 0, stdout: 'Logged in to github.com\n', stderr: '', error: null }
      if (args[0] === 'api') {
        const methodIdx = args.indexOf('--method')
        const method = methodIdx >= 0 ? String(args[methodIdx + 1]).toUpperCase() : 'GET'
        const endpoint = args.find((a) => a.startsWith('repos/')) ?? ''
        const envMatch = endpoint.match(/\/environments\/([^/]+)$/)
        if (envMatch) {
          const envName = envMatch[1]
          if (method === 'PUT') {
            if (state.faults.ghEnvPutFail) {
              return { status: 1, stdout: '', stderr: 'gh environment PUT failed (500)', error: null }
            }
            if (!state.github.environments.has(envName)) {
              state.github.environments.set(envName, { variables: new Map(), secrets: new Map() })
            }
            return { status: 0, stdout: JSON.stringify({ name: envName }), stderr: '', error: null }
          }
          if (!state.github.environments.has(envName)) {
            return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)', error: null }
          }
          return { status: 0, stdout: JSON.stringify({ name: envName }), stderr: '', error: null }
        }
        const wfMatch = endpoint.match(/\/actions\/workflows\/([^/]+)$/)
        if (wfMatch) {
          const wf = state.github.workflows.get(wfMatch[1])
          return wf
            ? { status: 0, stdout: JSON.stringify(wf), stderr: '', error: null }
            : { status: 1, stdout: '', stderr: 'Not Found', error: null }
        }
      }
      if (args[0] === 'variable' && args[1] === 'set') {
        const varName = args[2]
        const envIdx = args.indexOf('--env')
        const bodyIdx = args.indexOf('--body')
        const envName = envIdx >= 0 ? args[envIdx + 1] : null
        const value = bodyIdx >= 0 ? args[bodyIdx + 1] : ''
        if (state.faults.ghVarSetFailAt && varName === state.faults.ghVarSetFailAt) {
          return { status: 1, stdout: '', stderr: `gh variable set ${varName} failed (500)`, error: null }
        }
        if (envName) {
          const envObj = state.github.environments.get(envName) ?? { variables: new Map(), secrets: new Map() }
          state.github.environments.set(envName, envObj)
          envObj.variables.set(varName, value)
        }
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      if (args[0] === 'secret' && args[1] === 'list') {
        const envIdx = args.indexOf('--env')
        const envName = envIdx >= 0 ? args[envIdx + 1] : null
        const envObj = envName ? state.github.environments.get(envName) : null
        const names = envObj ? [...envObj.secrets.keys()] : []
        return { status: 0, stdout: names.join('\n'), stderr: '', error: null }
      }
      if (args[0] === 'secret' && args[1] === 'set') {
        const secretName = args[2]
        const envIdx = args.indexOf('--env')
        const envName = envIdx >= 0 ? args[envIdx + 1] : null
        if (state.faults.ghSecretSetFailAt && secretName === state.faults.ghSecretSetFailAt) {
          return { status: 1, stdout: '', stderr: `gh secret set ${secretName} failed (500)`, error: null }
        }
        if (envName) {
          const envObj = state.github.environments.get(envName) ?? { variables: new Map(), secrets: new Map() }
          state.github.environments.set(envName, envObj)
          envObj.secrets.set(secretName, { configured: true })
        }
        return { status: 0, stdout: '', stderr: '', error: null }
      }
      return { status: 0, stdout: '[]', stderr: '', error: null }
    }

    return { status: 0, stdout: '', stderr: '', error: null }
  }

  function createObjectStore(config) {
    const acctId = parseS3AccountId(config?.endpoint)
    const bucketName = String(config?.bucket ?? '')
    const accessKeyId = String(config?.accessKeyId ?? '')
    const secretAccessKey = String(config?.secretAccessKey ?? '')

    function authorize() {
      const minted = state.mintedTokens.get(accessKeyId)
      if (minted && sha256Hex(minted.value) === secretAccessKey) {
        // Enforce bucket-scoped policy
        const allowed = minted.policies.some((policy) => {
          const keys = Object.keys(policy?.resources ?? {})
          return keys.some((key) => {
            if (key === 'com.cloudflare.edge.r2.bucket.*') return true
            return key.toLowerCase() === `com.cloudflare.edge.r2.bucket.${acctId}_default_${bucketName}`.toLowerCase()
          })
        })
        if (!allowed) {
          throw makeHttpError(`AccessDenied: token ${accessKeyId} is not scoped to ${bucketName}`, 403, 'AccessDenied')
        }
        return
      }
      const override = state.operatorS3Overrides.get(accessKeyId)
      if (override && override.secretAccessKey === secretAccessKey) {
        if (override.allowedBuckets && !override.allowedBuckets.includes(bucketName)) {
          throw makeHttpError(`AccessDenied: override ${accessKeyId} cannot access ${bucketName}`, 403, 'AccessDenied')
        }
        return
      }
      throw makeHttpError('InvalidAccessKeyId / AccessDenied', 403, 'AccessDenied')
    }

    function resolveBucket() {
      authorize()
      const acct = findAccount(acctId)
      const bucket = acct?.buckets.get(bucketName)
      if (!bucket) {
        throw makeHttpError(`The specified bucket does not exist: ${bucketName}`, 404, 'NoSuchBucket')
      }
      return bucket
    }

    return {
      async list(prefix = '') {
        state.calls.s3.push({ op: 'list', bucket: bucketName, prefix })
        if (state.faults.s3ListFail) throw makeHttpError('S3 list error', 500)
        const b = resolveBucket()
        return [...b.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      },
      async head(key) {
        state.calls.s3.push({ op: 'head', bucket: bucketName, key })
        if (state.faults.s3HeadFailAfterWrite && key.includes('_isolation-probe')) {
          throw new Error('simulated S3 HEAD failure after probe write')
        }
        const b = resolveBucket()
        const entry = b.objects.get(key)
        if (!entry) return null
        return { etag: entry.etag, size: entry.body.length, contentType: entry.contentType }
      },
      async get(key) {
        state.calls.s3.push({ op: 'get', bucket: bucketName, key })
        const b = resolveBucket()
        const entry = b.objects.get(key)
        if (!entry) return null
        return { body: entry.body, etag: entry.etag, contentType: entry.contentType }
      },
      async put(key, body, options = {}) {
        state.calls.s3.push({ op: 'put', bucket: bucketName, key })
        if (state.faults.s3PutFail) throw makeHttpError('S3 put error', 500)
        const b = resolveBucket()
        const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body))
        b.objects.set(key, {
          body: bytes,
          contentType: options.contentType ?? 'application/octet-stream',
          etag: sha256Hex(key).slice(0, 16),
        })
        if (state.faults.s3PutLostResponse) {
          const err = new Error('network timeout after S3 PutObject')
          err.code = 'ETIMEDOUT'
          throw err
        }
        return { etag: sha256Hex(key).slice(0, 16) }
      },
      async delete(key) {
        state.calls.s3.push({ op: 'delete', bucket: bucketName, key })
        if (state.faults.s3DeleteFail) throw makeHttpError('S3 delete failed (500)', 500)
        const b = resolveBucket()
        b.objects.delete(key)
        return { deleted: true }
      },
      close() {},
    }
  }

  return {
    state,
    fetchImpl,
    spawnSyncImpl,
    createObjectStore,
    seedBucket,
    addOperatorS3Override,
    seedMintedToken,
    hasBucket(accountId, bucketName) {
      return Boolean(findAccount(accountId)?.buckets.has(bucketName))
    },
    getBucket(accountId, bucketName) {
      return findAccount(accountId)?.buckets.get(bucketName) ?? null
    },
    listObjects(accountId, bucketName) {
      const b = findAccount(accountId)?.buckets.get(bucketName)
      return b ? [...b.objects.keys()].sort() : null
    },
    hasGithubEnv(envName) {
      return state.github.environments.has(envName)
    },
    getGithubEnv(envName) {
      const env = state.github.environments.get(envName)
      if (!env) return null
      return {
        variables: Object.fromEntries(env.variables.entries()),
        secrets: [...env.secrets.keys()],
      }
    },
    snapshotUnrelatedBuckets(accountId = primaryAccountId) {
      const acct = findAccount(accountId)
      const out = {}
      for (const [name, b] of acct?.buckets.entries() ?? []) {
        if (!name.startsWith('unrelated-')) continue
        out[name] = {
          r2DevEnabled: b.r2DevEnabled,
          creationDate: b.creationDate,
          objects: Object.fromEntries([...b.objects.entries()].map(([k, v]) => [k, v.etag])),
        }
      }
      return out
    },
  }
}
