/**
 * Live Cloudflare / GitHub / EdgeOne I/O adapters for deploy-env --apply.
 *
 * Injectable via createLiveDevelopmentApplyIo({ spawnSyncImpl, fetchImpl, … }).
 * Unit tests must not hit live cloud — pass spawn/fetch doubles.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync as defaultSpawnSync } from 'node:child_process'

import {
  DEVELOPMENT_DEFAULTS,
  DEVELOPMENT_SECRET_KEYS,
  DEVELOPMENT_VARIABLE_KEYS,
  normalizeCorsAllowedMethods,
  redactSecrets,
  validateImageCdnConfig,
} from './deploy-env-lib.mjs'
import {
  assertCheckpointBucketPrivate,
  parseWranglerWhoamiJson,
} from './setup-staging-lib.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromNodeJobs = createRequire(join(ROOT, 'apps/node-jobs/package.json'))

const CF_API = 'https://api.cloudflare.com/client/v4'
const API_TIMEOUT_MS = 15_000
const WRANGLER = ['pnpm', 'exec', 'wrangler']
const ENV_FILE_NULL = ['--env-file', '/dev/null']

/** Workers R2 Storage Write permission group id (Cloudflare tokens API). */
const PG_R2_WRITE = 'e086da7e5abe4ad98b80f09ab37601ac'

/**
 * Stable name of the fallback R2 S3 token. Creation is the fallback path:
 * the primary derivation reuses the management token itself (id + SHA-256
 * value), so this token is only minted when the parent token lacks R2
 * object access. To prevent accumulation, an apply that must create this
 * token first deletes any prior token carrying the same stable name.
 */
const DERIVED_S3_TOKEN_NAME = 'airingcal-development-s3'

/** Repository-level gate variable the development writer job `if` reads. */
const DEVELOPMENT_WRITER_GATE_VAR = 'AIRINGCAL_DEVELOPMENT_WRITER_ENABLED'

/** Missing-scope label when the parent token cannot create child tokens. */
const TOKEN_CREATE_SCOPE = 'User API Tokens: Edit (Create tokens via API)'

/** Escape hatch printed alongside the missing scope. */
const S3_OVERRIDE_WORKAROUND =
  'override workaround: set AIRINGCAL_S3_ACCESS_KEY_ID / AIRINGCAL_S3_SECRET_ACCESS_KEY in .env'

const WRITER_TEST_POLL_MS = 5_000
const WRITER_TEST_DEADLINE_MS = 30 * 60_000

function tokenCreateDeniedError(detail = '') {
  const err = new Error(
    `Cloudflare API token cannot create R2 S3 API tokens${detail ? ` (${detail})` : ''} — missing scope: ${TOKEN_CREATE_SCOPE}; ${S3_OVERRIDE_WORKAROUND}`,
  )
  err.missingScopes = [TOKEN_CREATE_SCOPE, S3_OVERRIDE_WORKAROUND]
  return err
}

/**
 * Classify `GET /user/tokens/permissions` for the ability to create tokens.
 * CF has returned both object entries ({name,id,description}) and flat strings;
 * shapes without any API-token entry are inconclusive (the Create Token POST
 * itself then remains the authoritative enforcement point).
 *
 * @returns {'allowed'|'denied'|'unknown'}
 */
function classifyTokenCreationPermission(body) {
  const result = body?.result ?? body ?? {}
  if (!Array.isArray(result.permissions)) return 'unknown'
  const entries = result.permissions.map((p) =>
    typeof p === 'string'
      ? p
      : [p?.name, p?.id, p?.description].filter(Boolean).join(' '),
  )
  if (entries.length === 0) return 'unknown'
  const tokenish = entries.filter((e) => /api[ -]?tokens?|create additional tokens/i.test(e))
  if (tokenish.length === 0) return 'unknown'
  if (tokenish.some((e) => /edit|write|create/i.test(e))) return 'allowed'
  return 'denied'
}

function parseGhJson(result, label) {
  const out = String(result?.stdout ?? '').trim()
  try {
    return out ? JSON.parse(out) : null
  } catch {
    throw new Error(`${label}: unexpected gh output: ${out.slice(0, 200) || '(empty)'}`)
  }
}

/**
 * Zone rules must be host-scoped: a bare path expression would deny/cache
 * requests on every other site hosted in the same Cloudflare zone.
 */
function publicHostForRules(plan) {
  const host = String(plan?.publicHost ?? '')
    .trim()
    .replace(/:\d+$/, '')
  if (!host) {
    throw new Error(
      'plan.publicHost is required to scope zone WAF/cache rules to the R2 public host (zone-wide expressions would affect other sites)',
    )
  }
  return host
}

function isOkResponse(response) {
  if (!response) return false
  if (typeof response.ok === 'boolean') return response.ok
  const status = Number(response.status ?? 0)
  return status >= 200 && status < 300
}

function headerValue(response, name) {
  const headers = response?.headers
  if (!headers) return null
  if (typeof headers.get === 'function') return headers.get(name)
  const direct = headers[name] ?? headers[String(name).toLowerCase()]
  return typeof direct === 'string' ? direct : null
}

const RELEASE_IMAGE_HASH_RE = /^[0-9a-f]{64}$/

/**
 * Walk the published snapshot for real original-image hashes:
 * collections.*[].images.large.hash and calendar[].items[].images.large.hash.
 */
function collectReleaseImageHashes(snapshot) {
  const hashes = []
  const pushHash = (item) => {
    const hash = item?.images?.large?.hash
    if (typeof hash === 'string' && RELEASE_IMAGE_HASH_RE.test(hash)) hashes.push(hash)
  }
  const collections = snapshot?.collections
  if (collections && typeof collections === 'object') {
    for (const items of Object.values(collections)) {
      if (Array.isArray(items)) for (const item of items) pushHash(item)
    }
  }
  const calendar = snapshot?.calendar
  if (Array.isArray(calendar)) {
    for (const day of calendar) {
      if (Array.isArray(day?.items)) for (const item of day.items) pushHash(item)
    }
  }
  return hashes
}

export class MissingCapabilityError extends Error {
  /**
   * @param {string} capability
   * @param {string} [detail]
   */
  constructor(capability, detail = '') {
    super(
      detail
        ? `missing capability: ${capability} — ${detail}`
        : `missing capability: ${capability}`,
    )
    this.name = 'MissingCapabilityError'
    this.capability = capability
  }
}

export function missingCapability(stepId, detail) {
  return new MissingCapabilityError(stepId, detail)
}

function tokenFromEnv(env = {}) {
  return String(env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? '').trim()
}

function accountIdFrom(env = {}, plan = {}) {
  return String(
    env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID ?? plan.accountId ?? env.CLOUDFLARE_ACCOUNT_ID ?? '',
  )
    .trim()
    .toLowerCase()
}

function zoneIdFrom(env = {}) {
  return String(env.AIRINGCAL_ZONE_ID ?? env.CLOUDFLARE_ZONE_ID ?? '').trim()
}

function secretList(env = {}) {
  return [
    env.AIRINGCAL_CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_TOKEN,
    env.AIRINGCAL_BANGUMI_TOKEN,
    env.AIRINGCAL_S3_ACCESS_KEY_ID,
    env.AIRINGCAL_S3_SECRET_ACCESS_KEY,
    env.AIRINGCAL_EDGEONE_API_TOKEN,
  ].filter((v) => typeof v === 'string' && v.trim().length >= 4)
}

function assertSpawnOk(result, label, secrets = []) {
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const out = redactSecrets(
      `${result.stderr || ''}\n${result.stdout || ''}`.trim(),
      secrets,
    )
    throw new Error(`${label} failed (exit ${result.status}): ${out || '(no output)'}`)
  }
  return result
}

export function runWrangler(spawnSyncImpl, subArgs, env, opts = {}) {
  const secrets = secretList(env)
  const args = [...WRANGLER.slice(1), ...subArgs, ...ENV_FILE_NULL]
  const result = spawnSyncImpl(WRANGLER[0], args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: {
      ...process.env,
      ...env,
      CLOUDFLARE_API_TOKEN: tokenFromEnv(env) || process.env.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: accountIdFrom(env) || process.env.CLOUDFLARE_ACCOUNT_ID,
    },
    input: opts.input,
  })
  assertSpawnOk(result, `wrangler ${subArgs.join(' ')}`, secrets)
  return result
}

export function runGh(spawnSyncImpl, args, env, opts = {}) {
  const secrets = secretList(env)
  const result = spawnSyncImpl('gh', args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...env },
    input: opts.input,
  })
  assertSpawnOk(result, `gh ${args.join(' ')}`, secrets)
  return result
}

export async function cfApi(fetchImpl, token, path, init = {}) {
  const response = await fetchImpl(`${CF_API}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    const errors = Array.isArray(body.errors) ? body.errors : []
    const message =
      errors.map((e) => `${e.code ?? 'unknown'} ${e.message ?? ''}`.trim()).join('; ') ||
      `Cloudflare API ${path} failed: ${response.status}`
    const err = new Error(message)
    err.status = response.status
    err.errors = errors
    throw err
  }
  return body
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function s3EndpointFor(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

export function createDefaultObjectStore(config) {
  const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command } =
    requireFromNodeJobs('@aws-sdk/client-s3')
  const client = new S3Client({
    region: config.region || 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
    maxAttempts: 3,
  })

  return {
    async head(key) {
      try {
        const response = await client.send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: key }),
        )
        return {
          etag: response.ETag ? String(response.ETag).replaceAll('"', '') : null,
          size: Number(response.ContentLength ?? 0),
          contentType: response.ContentType ?? null,
        }
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode
        if (status === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') {
          return null
        }
        throw error
      }
    },
    async get(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        )
        if (!response.Body) return null
        const body = await response.Body.transformToByteArray()
        return {
          body,
          etag: response.ETag ? String(response.ETag).replaceAll('"', '') : null,
          contentType: response.ContentType ?? null,
        }
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode
        if (status === 404 || error?.name === 'NotFound' || error?.Code === 'NotFound') {
          return null
        }
        throw error
      }
    },
    async put(key, body, options = {}) {
      const response = await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
        }),
      )
      return {
        etag: response.ETag ? String(response.ETag).replaceAll('"', '') : null,
      }
    },
    async list(prefix) {
      const keys = []
      let token
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        )
        for (const item of response.Contents ?? []) {
          if (item.Key) keys.push(item.Key)
        }
        token = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (token)
      return keys.sort()
    },
    close() {
      client.destroy?.()
    },
  }
}

function normalizeLooseEtag(etag) {
  return String(etag ?? '')
    .trim()
    .replace(/^W\//, '')
    .replaceAll('"', '')
}

async function copyPrefixes({ createObjectStore, s3Creds, sourceBucket, destBucket, prefixes }) {
  const source = createObjectStore({ ...s3Creds, bucket: sourceBucket })
  const dest = createObjectStore({ ...s3Creds, bucket: destBucket })
  let copied = 0
  let skipped = 0
  try {
    for (const prefix of prefixes) {
      const keys = await source.list(prefix)
      for (const key of keys) {
        if (key.endsWith('/')) continue
        const srcHead = await source.head(key)
        if (!srcHead) continue
        const dstHead = await dest.head(key)
        if (
          dstHead &&
          Number(dstHead.size) === Number(srcHead.size) &&
          normalizeLooseEtag(dstHead.etag) === normalizeLooseEtag(srcHead.etag)
        ) {
          skipped += 1
          continue
        }
        const obj = await source.get(key)
        if (!obj?.body) continue
        await dest.put(key, obj.body, {
          contentType: obj.contentType ?? srcHead.contentType ?? undefined,
        })
        copied += 1
      }
    }
  } finally {
    source.close?.()
    dest.close?.()
  }
  return { copied, skipped, sourceBucket, destBucket, prefixes }
}

async function getZonePhaseEntrypoint(fetchImpl, token, zoneId, phase) {
  try {
    const body = await cfApi(
      fetchImpl,
      token,
      `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`,
    )
    return body.result ?? null
  } catch (error) {
    if (Number(error?.status) === 404) return null
    throw error
  }
}

async function ensureZonePhaseRule({
  fetchImpl,
  token,
  zoneId,
  phase,
  description,
  expression,
  action,
  actionParameters,
}) {
  let entry = await getZonePhaseEntrypoint(fetchImpl, token, zoneId, phase)
  const matchExisting = (rules) =>
    (rules ?? []).find(
      (rule) =>
        String(rule.description ?? '') === description ||
        String(rule.expression ?? '') === expression,
    )

  if (!entry) {
    const created = await cfApi(fetchImpl, token, `/zones/${zoneId}/rulesets`, {
      method: 'POST',
      body: JSON.stringify({
        name: `airingcal-${phase}`,
        kind: 'zone',
        phase,
        rules: [
          {
            description,
            expression,
            action,
            ...(actionParameters ? { action_parameters: actionParameters } : {}),
            enabled: true,
          },
        ],
      }),
    })
    return { created: true, rulesetId: created.result?.id ?? null }
  }

  const existing = matchExisting(entry.rules)
  if (existing) {
    const descriptionMatches = String(existing.description ?? '') === description
    const expressionMatches = String(existing.expression ?? '') === expression
    if (descriptionMatches && expressionMatches) {
      return { created: false, reused: true, rulesetId: entry.id, ruleId: existing.id }
    }
    // Description match with a stale expression (e.g. pre-fix zone-wide path
    // rules) — update the rule in place so a re-apply never leaves the old
    // expression live. PATCH a single rule per the Cloudflare rulesets API.
    await cfApi(
      fetchImpl,
      token,
      `/zones/${zoneId}/rulesets/${entry.id}/rules/${encodeURIComponent(String(existing.id))}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          description,
          expression,
          action,
          ...(actionParameters ? { action_parameters: actionParameters } : {}),
          enabled: true,
        }),
      },
    )
    return {
      created: false,
      updated: true,
      reason: expressionMatches ? 'description-changed' : 'expression-changed',
      rulesetId: entry.id,
      ruleId: existing.id,
    }
  }

  const added = await cfApi(
    fetchImpl,
    token,
    `/zones/${zoneId}/rulesets/${entry.id}/rules`,
    {
      method: 'POST',
      body: JSON.stringify({
        description,
        expression,
        action,
        ...(actionParameters ? { action_parameters: actionParameters } : {}),
        enabled: true,
      }),
    },
  )
  return { created: true, rulesetId: entry.id, ruleId: added.result?.id ?? null }
}

function isNoSuchBucket(error) {
  const msg = error instanceof Error ? error.message : String(error)
  const code = error?.Code || error?.name || error?.code
  return (
    code === 'NoSuchBucket' ||
    Number(error?.$metadata?.httpStatusCode) === 404 ||
    /NoSuchBucket|The specified bucket does not exist/i.test(msg)
  )
}

function isAccessDenied(error) {
  const msg = error instanceof Error ? error.message : String(error)
  const code = error?.Code || error?.name || error?.code
  return (
    code === 'AccessDenied' ||
    Number(error?.$metadata?.httpStatusCode) === 403 ||
    /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(msg)
  )
}

async function resolvePermissionGroupId(fetchImpl, token, name) {
  const body = await cfApi(fetchImpl, token, '/user/tokens/permission_groups')
  const groups = Array.isArray(body.result) ? body.result : []
  const match = groups.find((g) => String(g.name ?? '') === name)
  if (!match?.id) {
    throw new Error(`Cloudflare permission group not found: ${name}`)
  }
  return String(match.id)
}

export function createLiveDevelopmentApplyIo({
  env = {},
  plan,
  spawnSyncImpl = defaultSpawnSync,
  fetchImpl = globalThis.fetch,
  createObjectStore = createDefaultObjectStore,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  nowImpl = () => Date.now(),
} = {}) {
  if (!plan) throw new Error('createLiveDevelopmentApplyIo requires plan')

  const secrets = secretList(env)
  const bucket = plan.bucket || DEVELOPMENT_DEFAULTS.bucket
  const probeKey = DEVELOPMENT_DEFAULTS.isolationProbeKey
  const probeBody = DEVELOPMENT_DEFAULTS.isolationProbeBody
  const probeUrl = `${plan.publicBaseUrl}/${probeKey}`
  const repo = plan.repository || DEVELOPMENT_DEFAULTS.repository

  /** @type {{ accessKeyId: string, secretAccessKey: string, endpoint: string, region: string, derived: boolean } | null} */
  let s3Creds = null

  function requireS3() {
    if (!s3Creds?.accessKeyId || !s3Creds?.secretAccessKey) {
      throw new Error('S3 credentials not derived/verified; deriveAndVerifyS3 must run first')
    }
    return s3Creds
  }

  function objectStoreFor(bucketName) {
    const creds = requireS3()
    return createObjectStore({
      endpoint: creds.endpoint,
      region: creds.region || 'auto',
      bucket: bucketName,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })
  }

  async function verifyS3Access(creds, targetBucket, { allowMissingBucket = false } = {}) {
    const store = createObjectStore({
      endpoint: creds.endpoint,
      region: creds.region || 'auto',
      bucket: targetBucket,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    })
    try {
      await store.list('')
      await store.head(probeKey)
      return { verified: true, bucketReady: true }
    } catch (error) {
      if (allowMissingBucket && isNoSuchBucket(error)) {
        return { verified: true, bucketReady: false }
      }
      if (isAccessDenied(error)) {
        const err = new Error(
          `S3 credentials failed list+head on ${targetBucket}: access denied / missing scopes`,
        )
        err.missingScopes = ['Workers R2 Storage Write', 'R2 S3 API token derivation']
        throw err
      }
      throw error
    } finally {
      store.close?.()
    }
  }

  return {
    async probeToken(ctx = {}) {
      const token = tokenFromEnv(env)
      if (!token) {
        return {
          ok: false,
          missingScopes: [
            'Workers R2 Storage Write',
            'Workers Scripts Write',
            'R2 S3 API token derivation',
          ],
        }
      }

      const missingScopes = []
      try {
        const whoami = runWrangler(
          spawnSyncImpl,
          ['whoami', '--json'],
          { ...env, CLOUDFLARE_API_TOKEN: token },
        )
        const accountId = parseWranglerWhoamiJson(whoami.stdout)
        ctx.accountId = accountId
        if (!accountIdFrom(env, plan)) {
          env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID = accountId
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (/not authenticated|Unauthorized|403|401|login/i.test(msg)) {
          missingScopes.push('Cloudflare API token authentication (wrangler whoami)')
        } else {
          missingScopes.push(`wrangler whoami: ${redactSecrets(msg, secrets)}`)
        }
      }

      try {
        runWrangler(spawnSyncImpl, ['r2', 'bucket', 'list'], {
          ...env,
          CLOUDFLARE_API_TOKEN: token,
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        missingScopes.push(
          /403|401|permission|scope|auth/i.test(msg)
            ? 'Workers R2 Storage Write (wrangler r2 bucket list)'
            : `wrangler r2 bucket list: ${redactSecrets(msg, secrets)}`,
        )
      }

      if (missingScopes.length > 0) {
        return { ok: false, missingScopes }
      }
      return { ok: true, missingScopes: [], tokenPresent: true, accountId: ctx.accountId }
    },

    async deriveAndVerifyS3(ctx = {}) {
      const accountId = accountIdFrom(env, plan) || ctx.accountId
      if (!accountId) {
        throw new Error('AIRINGCAL_CLOUDFLARE_ACCOUNT_ID required to derive/verify S3 credentials')
      }
      const endpoint = s3EndpointFor(accountId)
      const overrideId = String(env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()
      const overrideSecret = String(env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()

      if (overrideId && overrideSecret) {
        const creds = {
          accessKeyId: overrideId,
          secretAccessKey: overrideSecret,
          endpoint,
          region: String(env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
          derived: false,
        }
        await verifyS3Access(creds, bucket, { allowMissingBucket: true })
        s3Creds = creds
        ctx.s3 = { accessKeyId: overrideId, derived: false, verified: true }
        process.stderr.write(
          `[deploy-env] S3 override Access Key ID ${overrideId} verified on ${bucket}\n`,
        )
        return {
          accessKeyId: overrideId,
          secretAccessKey: overrideSecret,
          derived: false,
          verified: true,
          keyIdPrinted: overrideId,
        }
      }

      const parentToken = tokenFromEnv(env)
      if (!parentToken) {
        throw new Error(
          'Cloudflare API token required to derive R2 S3 credentials (no AIRINGCAL_S3_* override set)',
        )
      }

      // 2. Primary path — self-derivation from the management token, zero new
      //    tokens ("Get S3 API credentials from an API token", Cloudflare R2
      //    docs): Access Key ID = the token `id` reported by
      //    GET /user/tokens/verify, Secret Access Key = SHA-256 of the token
      //    value. Any failure here — verify denied, `result`/`id` missing
      //    (docs mark result optional), or the parent token lacking R2
      //    object access on list+head — falls through to the dedicated
      //    scoped-token fallback; never a silent pass.
      try {
        const verifyBody = await cfApi(fetchImpl, parentToken, '/user/tokens/verify')
        const tokenId = String(verifyBody?.result?.id ?? '').trim()
        if (tokenId) {
          const creds = {
            accessKeyId: tokenId,
            secretAccessKey: sha256Hex(parentToken),
            endpoint,
            region: 'auto',
            derived: true,
            source: 'management-token',
          }
          try {
            await verifyS3Access(creds, bucket, { allowMissingBucket: true })
            s3Creds = creds
            ctx.s3 = {
              accessKeyId: tokenId,
              derived: true,
              source: 'management-token',
              verified: true,
            }
            process.stderr.write(
              `[deploy-env] Derived R2 S3 Access Key ID ${tokenId} from the management token (secret redacted)\n`,
            )
            return {
              accessKeyId: tokenId,
              secretAccessKey: creds.secretAccessKey,
              derived: true,
              source: 'management-token',
              verified: true,
              keyIdPrinted: tokenId,
            }
          } catch (error) {
            // Object-permission (or other) failure with the management token —
            // the dedicated scoped token in step 3 may still work.
            const msg = error instanceof Error ? error.message : String(error)
            process.stderr.write(
              `[deploy-env] Management-token S3 derivation not usable (${redactSecrets(msg, secrets)}); trying scoped-token fallback\n`,
            )
          }
        } else {
          process.stderr.write(
            '[deploy-env] GET /user/tokens/verify returned no token id; trying scoped-token fallback\n',
          )
        }
      } catch {
        // Verify endpoint denied/unusual shape → fall back to token creation.
        process.stderr.write(
          '[deploy-env] Management token could not be verified; trying scoped-token fallback\n',
        )
      }

      // 3. Fallback — dedicated scoped token. Probe the parent token's ability
      //    to create tokens BEFORE POSTing, so a scope-less token fails with
      //    the explicit missing-scope message instead of an opaque Create
      //    Token error.
      try {
        const permissionsBody = await cfApi(fetchImpl, parentToken, '/user/tokens/permissions')
        const verdict = classifyTokenCreationPermission(permissionsBody)
        if (verdict === 'denied') {
          throw tokenCreateDeniedError('permission probe shows no edit/create on user API tokens')
        }
      } catch (error) {
        if (error?.missingScopes) throw error
        const status = Number(error?.status)
        const msg = error instanceof Error ? error.message : String(error)
        if (status === 403 || status === 401 || /unauthoriz|forbidden|denied|permission/i.test(msg)) {
          throw tokenCreateDeniedError(`GET /user/tokens/permissions: ${redactSecrets(msg, secrets)}`)
        }
        throw error
      }

      const tokenName = DERIVED_S3_TOKEN_NAME

      // Anti-accumulation: delete any pre-existing token carrying the stable
      // fallback name before creating a replacement, so repeated applies do
      // not leave multiple airingcal-development-s3 tokens behind. Listing and
      // deletion are best effort (a token may not see other users' tokens);
      // the POST below remains the authoritative enforcement point.
      try {
        const listed = await cfApi(fetchImpl, parentToken, '/user/tokens')
        const prior = (Array.isArray(listed?.result) ? listed.result : []).filter(
          (t) => String(t?.name ?? '') === tokenName && t?.id,
        )
        for (const t of prior) {
          try {
            await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(String(t.id))}`, {
              method: 'DELETE',
            })
            process.stderr.write(
              `[deploy-env] Deleted prior R2 S3 token ${t.id} (stable name) before re-creating\n`,
            )
          } catch {
            // Deletion denied/stale — creation still proceeds; CF enforces.
          }
        }
      } catch {
        // Token listing not permitted for this parent; proceed to create.
      }

      let permissionGroupId = PG_R2_WRITE
      try {
        permissionGroupId = await resolvePermissionGroupId(
          fetchImpl,
          parentToken,
          'Workers R2 Storage Write',
        )
      } catch (error) {
        // Fall back to known id from CF docs samples when listing is denied.
        const msg = error instanceof Error ? error.message : String(error)
        if (!/permission group not found|403|401|denied/i.test(msg) && !permissionGroupId) {
          throw error
        }
      }
      let created
      try {
        created = await cfApi(fetchImpl, parentToken, '/user/tokens', {
          method: 'POST',
          body: JSON.stringify({
            name: tokenName,
            policies: [
              {
                effect: 'allow',
                resources: {
                  [`com.cloudflare.api.account.${accountId}`]: {
                    'com.cloudflare.edge.r2.bucket.*': '*',
                  },
                },
                permission_groups: [{ id: permissionGroupId }],
              },
            ],
          }),
        })
      } catch (error) {
        // The probe can be inconclusive on unusual response shapes; the POST
        // itself is the authoritative enforcement point.
        const status = Number(error?.status)
        const msg = error instanceof Error ? error.message : String(error)
        if (status === 403 || status === 401 || /unauthoriz|not authorized|denied/i.test(msg)) {
          throw tokenCreateDeniedError(`POST /user/tokens: ${redactSecrets(msg, secrets)}`)
        }
        throw error
      }

      const result = created.result ?? created
      const accessKeyId = String(result.id ?? '').trim()
      const tokenValue = String(result.value ?? '').trim()
      if (!accessKeyId || !tokenValue) {
        throw new Error(
          'Cloudflare Create Token API did not return id+value for R2 S3 derivation (missing scopes?)',
        )
      }
      const secretAccessKey = sha256Hex(tokenValue)
      const creds = {
        accessKeyId,
        secretAccessKey,
        endpoint,
        region: 'auto',
        derived: true,
      }

      try {
        await verifyS3Access(creds, bucket, { allowMissingBucket: true })
      } catch (error) {
        if (error?.missingScopes) throw error
        const msg = error instanceof Error ? error.message : String(error)
        const err = new Error(
          `Derived S3 credentials failed list+head on ${bucket}: ${redactSecrets(msg, secrets)}. missing scopes: Workers R2 Storage Write`,
        )
        err.missingScopes = ['Workers R2 Storage Write', 'R2 S3 API token derivation']
        throw err
      }

      s3Creds = creds
      ctx.s3 = { accessKeyId, derived: true, verified: true }
      process.stderr.write(
        `[deploy-env] Created scoped R2 S3 token ${accessKeyId} (fallback path; secret redacted)\n`,
      )
      return {
        accessKeyId,
        secretAccessKey,
        derived: true,
        verified: true,
        keyIdPrinted: accessKeyId,
      }
    },

    async freezeWriter(ctx = {}) {
      const workflow = plan.writerFreeze?.workflow || 'portable-writer.yml'
      runGh(spawnSyncImpl, ['workflow', 'disable', workflow, '--repo', repo], env)

      const deadline = nowImpl() + 15 * 60_000
      let inProgress = -1
      while (nowImpl() < deadline) {
        const listed = runGh(
          spawnSyncImpl,
          [
            'run',
            'list',
            `--workflow=${workflow}`,
            '--status',
            'in_progress',
            '--repo',
            repo,
            '--json',
            'databaseId,status,name',
          ],
          env,
        )
        let runs = []
        try {
          runs = JSON.parse(listed.stdout || '[]')
        } catch {
          runs = []
        }
        inProgress = Array.isArray(runs) ? runs.length : 0
        if (inProgress === 0) break
        await sleepImpl(5_000)
      }
      if (inProgress !== 0) {
        throw new Error(
          `writer-freeze: ${workflow} still has ${inProgress} in_progress run(s) after wait`,
        )
      }

      ctx.writerFrozen = true
      return {
        lever: 'workflow-disable',
        workflow,
        inProgress: 0,
        leaseClear: true,
        note: 'Lease clear assumed after in_progress=0; staging dispatch blocked via workflow disable',
      }
    },

    async ensureBucket() {
      const info = spawnSyncImpl(
        WRANGLER[0],
        [...WRANGLER.slice(1), 'r2', 'bucket', 'info', bucket, '--json', ...ENV_FILE_NULL],
        {
          encoding: 'utf8',
          cwd: ROOT,
          env: {
            ...process.env,
            ...env,
            CLOUDFLARE_API_TOKEN: tokenFromEnv(env),
            CLOUDFLARE_ACCOUNT_ID: accountIdFrom(env, plan),
          },
        },
      )
      let created = false
      if (info.status !== 0) {
        runWrangler(spawnSyncImpl, ['r2', 'bucket', 'create', bucket], env)
        created = true
      }
      if (s3Creds) {
        await verifyS3Access(s3Creds, bucket, { allowMissingBucket: false })
      }
      return { bucket, created }
    },

    async disableR2Dev() {
      runWrangler(spawnSyncImpl, ['r2', 'bucket', 'dev-url', 'disable', bucket, '-y'], env)
      const got = runWrangler(spawnSyncImpl, ['r2', 'bucket', 'dev-url', 'get', bucket], env)
      assertCheckpointBucketPrivate(got.stdout, bucket)
      return { disabled: true, bucket }
    },

    async attachCustomDomain() {
      const zoneId = zoneIdFrom(env)
      const domain = plan.publicHost
      if (!zoneId) {
        throw missingCapability(
          'attach-custom-domain',
          'missing AIRINGCAL_ZONE_ID (or CLOUDFLARE_ZONE_ID) for custom domain/WAF/cache rules',
        )
      }
      if (!domain) {
        throw new Error('plan.publicHost required to attach custom domain')
      }

      const listed = runWrangler(spawnSyncImpl, ['r2', 'bucket', 'domain', 'list', bucket], env)
      if (listed.stdout && listed.stdout.includes(domain)) {
        return { attached: true, domain, reused: true }
      }

      runWrangler(
        spawnSyncImpl,
        [
          'r2',
          'bucket',
          'domain',
          'add',
          bucket,
          '--domain',
          domain,
          '--zone-id',
          zoneId,
          '-y',
        ],
        env,
      )
      return { attached: true, domain, reused: false }
    },

    async applyCacheRules() {
      const zoneId = zoneIdFrom(env)
      const token = tokenFromEnv(env)
      if (!zoneId) {
        throw missingCapability(
          'cache-rules',
          'missing AIRINGCAL_ZONE_ID (or equivalent) for custom domain/WAF/cache rules',
        )
      }
      if (!token) throw new Error('Cloudflare API token required for cache rules')
      // Host-scoped: zone-wide expressions would alter caching on every other
      // site in the zone.
      const host = publicHostForRules(plan)

      const immutable = await ensureZonePhaseRule({
        fetchImpl,
        token,
        zoneId,
        phase: 'http_request_cache_settings',
        description: 'airingcal-images-snapshots-immutable',
        expression:
          `(http.host eq "${host}" and (starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/snapshots/")))`,
        action: 'set_cache_settings',
        actionParameters: {
          cache: true,
          edge_ttl: { mode: 'override_origin', default: 31536000 },
          browser_ttl: { mode: 'override_origin', default: 31536000 },
        },
      })
      const pointer = await ensureZonePhaseRule({
        fetchImpl,
        token,
        zoneId,
        phase: 'http_request_cache_settings',
        description: 'airingcal-pointer-bypass',
        expression: `(http.host eq "${host}" and http.request.uri.path eq "/public/current-release.json")`,
        action: 'set_cache_settings',
        actionParameters: {
          cache: false,
        },
      })
      return { ok: true, zoneId, host, immutable, pointer }
    },

    async applyCors() {
      const origins = plan.cors?.allowedOrigins ?? []
      // R2 AllowedMethods rejects OPTIONS (preflight is answered by the CORS
      // mechanism itself); normalizeCorsAllowedMethods throws on it.
      const methods = normalizeCorsAllowedMethods(
        plan.cors?.methods ?? DEVELOPMENT_DEFAULTS.corsMethods,
      )
      if (!Array.isArray(origins) || origins.length === 0) {
        throw new Error('CORS AllowedOrigins empty — refusing to apply open CORS')
      }
      for (const origin of origins) {
        if (String(origin).includes('*')) {
          throw new Error(`CORS AllowedOrigins must be exact (no wildcards): ${origin}`)
        }
      }

      const corsConfig = [
        {
          AllowedOrigins: origins,
          AllowedMethods: methods,
          AllowedHeaders: ['*'],
          ExposeHeaders: ['ETag', 'Content-Type', 'Content-Length'],
          MaxAgeSeconds: 86400,
        },
      ]
      const dir = mkdtempSync(join(tmpdir(), 'airingcal-cors-'))
      const file = join(dir, 'cors.json')
      try {
        writeFileSync(file, `${JSON.stringify(corsConfig, null, 2)}\n`, 'utf8')
        runWrangler(
          spawnSyncImpl,
          ['r2', 'bucket', 'cors', 'set', bucket, '--file', file, '-y'],
          env,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return { ok: true, allowedOrigins: origins, methods, corsFileWritten: true }
    },

    async configureWaf() {
      const zoneId = zoneIdFrom(env)
      const token = tokenFromEnv(env)
      if (!zoneId) {
        throw missingCapability(
          'waf-checkpoints',
          'missing AIRINGCAL_ZONE_ID (or equivalent) for custom domain/WAF/cache rules',
        )
      }
      if (!token) throw new Error('Cloudflare API token required for WAF rules')
      const host = publicHostForRules(plan)

      const rule = await ensureZonePhaseRule({
        fetchImpl,
        token,
        zoneId,
        phase: 'http_request_firewall_custom',
        description: 'airingcal-deny-checkpoints',
        expression: `(http.host eq "${host}" and starts_with(http.request.uri.path, "/checkpoints/"))`,
        action: 'block',
        actionParameters: {
          response: {
            status_code: 403,
            content: 'Forbidden',
            content_type: 'text/plain',
          },
        },
      })
      return { ok: true, zoneId, host, rule }
    },

    async writeIsolationProbe() {
      const store = objectStoreFor(bucket)
      try {
        await store.put(probeKey, new TextEncoder().encode(probeBody), {
          contentType: 'text/plain; charset=utf-8',
        })
      } finally {
        store.close?.()
      }
      return { key: probeKey, body: probeBody }
    },

    async probeAnonymousAccess(ctx = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('fetchImpl required for isolation anonymous GET/HEAD probes')
      }
      const probes = []
      for (const method of ['GET', 'HEAD']) {
        const response = await fetchImpl(probeUrl, { method, redirect: 'manual' })
        probes.push({ url: probeUrl, method, status: Number(response.status) })
      }
      return { r2DevDisabled: Boolean(ctx?.r2DevDisabled), probes }
    },

    async copyPublicPrefixes(ctx = {}) {
      if (ctx.isolation?.ok === false) {
        throw new Error('Refusing copyPublicPrefixes after isolation failure')
      }
      const sourceBucket = DEVELOPMENT_DEFAULTS.stagingSource.publicBucket
      return copyPrefixes({
        createObjectStore,
        s3Creds: requireS3(),
        sourceBucket,
        destBucket: bucket,
        prefixes: ['public/', 'snapshots/', 'images/'],
      })
    },

    async copyCheckpoints(ctx = {}) {
      if (ctx.isolation?.ok === false) {
        throw new Error('Refusing copyCheckpoints after isolation failure')
      }
      const sourceBucket = DEVELOPMENT_DEFAULTS.stagingSource.checkpointBucket
      return copyPrefixes({
        createObjectStore,
        s3Creds: requireS3(),
        sourceBucket,
        destBucket: bucket,
        prefixes: ['checkpoints/'],
      })
    },

    async syncGithubEnvironment(ctx = {}) {
      const envName = 'development'
      runGh(spawnSyncImpl, ['api', '--method', 'PUT', `repos/${repo}/environments/${envName}`], env)

      const accountId = accountIdFrom(env, plan) || ctx.accountId || ''
      const variables = {
        AIRINGCAL_DEVELOPMENT_PRIMARY_USER_ID: String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim(),
        AIRINGCAL_DEVELOPMENT_CLOUDFLARE_ACCOUNT_ID: accountId,
        AIRINGCAL_DEVELOPMENT_PUBLIC_BASE_URL: plan.publicBaseUrl,
        AIRINGCAL_DEVELOPMENT_R2_BUCKET: bucket,
        AIRINGCAL_DEVELOPMENT_S3_ENDPOINT: s3EndpointFor(accountId),
        AIRINGCAL_DEVELOPMENT_S3_REGION: String(env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
        AIRINGCAL_DEVELOPMENT_WORKER_NAME:
          plan.cloudflareWorkerName || DEVELOPMENT_DEFAULTS.workerName,
        AIRINGCAL_DEVELOPMENT_WRITER_ENABLED: 'false',
      }
      if (env.AIRINGCAL_USERS_JSON) {
        variables.AIRINGCAL_DEVELOPMENT_USERS_JSON = String(env.AIRINGCAL_USERS_JSON)
      }

      const syncedVars = []
      for (const [name, value] of Object.entries(variables)) {
        if (
          !DEVELOPMENT_VARIABLE_KEYS.includes(name) &&
          name !== 'AIRINGCAL_DEVELOPMENT_USERS_JSON'
        ) {
          continue
        }
        if (!value && name !== 'AIRINGCAL_DEVELOPMENT_WRITER_ENABLED') continue
        runGh(
          spawnSyncImpl,
          ['variable', 'set', name, '--env', envName, '--repo', repo, '--body', String(value)],
          env,
        )
        syncedVars.push(name)
      }

      const listRes = runGh(
        spawnSyncImpl,
        ['secret', 'list', '--env', envName, '--repo', repo, '--json', 'name', '--jq', '.[].name'],
        env,
      )
      const existing = new Set(
        String(listRes.stdout ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      )

      const s3 = requireS3()
      const secretMap = {
        AIRINGCAL_DEVELOPMENT_BANGUMI_TOKEN: String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim(),
        AIRINGCAL_DEVELOPMENT_S3_ACCESS_KEY_ID: s3.accessKeyId,
        AIRINGCAL_DEVELOPMENT_S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      }
      const syncedSecrets = []
      const missingSecrets = []
      for (const [name, value] of Object.entries(secretMap)) {
        if (!DEVELOPMENT_SECRET_KEYS.includes(name)) continue
        if (value) {
          runGh(
            spawnSyncImpl,
            ['secret', 'set', name, '--env', envName, '--repo', repo],
            env,
            { input: value },
          )
          syncedSecrets.push(name)
        } else if (!existing.has(name)) {
          missingSecrets.push(name)
        }
      }

      if (missingSecrets.length > 0) {
        const err = new Error(`Missing required GitHub secrets: ${missingSecrets.join(', ')}`)
        err.exitCode = 2
        throw err
      }

      return {
        environment: envName,
        variablesSynced: syncedVars,
        secretsSynced: syncedSecrets,
        writerEnabled: false,
      }
    },

    async deployCloudflareReader() {
      const workerName = plan.cloudflareWorkerName || DEVELOPMENT_DEFAULTS.workerName
      const outDir = mkdtempSync(join(tmpdir(), 'airingcal-wrangler-'))
      const outToml = join(outDir, 'wrangler-v3-read-development.toml')
      const sourceToml = join(ROOT, 'apps/v3-read-worker/wrangler.toml')
      const gitSha =
        String(env.BANGUMI_GIT_COMMIT_SHA ?? '').trim() ||
        (() => {
          const r = spawnSyncImpl('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
            cwd: ROOT,
          })
          return (r.stdout || '').trim()
        })()

      try {
        const mat = spawnSyncImpl(
          process.execPath,
          [join(ROOT, 'scripts/materialize-v3-read-staging-config.mjs'), sourceToml, outToml],
          {
            encoding: 'utf8',
            cwd: ROOT,
            env: {
              ...process.env,
              ...env,
              AIRINGCAL_STAGING_PUBLIC_R2_BUCKET: bucket,
              AIRINGCAL_STAGING_PUBLIC_BASE_URL: plan.publicBaseUrl,
              // Explicit (empty when unset) so process.env can never leak an
              // image base into a deploy where the caller did not configure one.
              AIRINGCAL_IMAGE_BASE_URL: String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim(),
              BANGUMI_GIT_COMMIT_SHA: gitSha,
              PACKAGE_VERSION: String(env.PACKAGE_VERSION ?? '').trim(),
            },
          },
        )
        assertSpawnOk(mat, 'materialize-v3-read-staging-config', secrets)

        const deploy = runWrangler(
          spawnSyncImpl,
          ['deploy', '--config', outToml, '--name', workerName],
          env,
        )
        const urlMatch = String(deploy.stdout || '').match(
          /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i,
        )
        return {
          deployed: true,
          workerName,
          workerUrl: urlMatch ? urlMatch[0] : null,
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true })
      }
    },

    async deployEdgeoneOverseas() {
      const project = plan.edgeone?.project || DEVELOPMENT_DEFAULTS.edgeoneProject
      const region = plan.edgeone?.region || DEVELOPMENT_DEFAULTS.edgeoneRegion
      const token = String(env.AIRINGCAL_EDGEONE_API_TOKEN ?? '').trim()
      if (!token) {
        throw missingCapability(
          'deploy-edgeone',
          'AIRINGCAL_EDGEONE_API_TOKEN required for edgeone makers deploy/env set',
        )
      }

      const build = spawnSyncImpl(
        'pnpm',
        ['-F', '@airing-cal/node-jobs', 'build:edgeone-read'],
        { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
      )
      assertSpawnOk(build, 'build:edgeone-read', secrets)

      const dist = join(ROOT, 'apps/edgeone-read-worker/dist')
      const deploy = spawnSyncImpl(
        'edgeone',
        [
          'makers',
          'deploy',
          dist,
          '-n',
          project,
          '-a',
          region,
          '-t',
          token,
          '-e',
          'production',
        ],
        { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
      )
      assertSpawnOk(deploy, `edgeone makers deploy -n ${project}`, secrets)

      const envPairs = [
        ['AIRINGCAL_PUBLIC_BASE_URL', plan.publicBaseUrl],
        ['NSFW_SHOW', String(env.AIRINGCAL_NSFW_SHOW ?? 'false')],
      ]
      if (env.PACKAGE_VERSION) {
        envPairs.push(['PACKAGE_VERSION', String(env.PACKAGE_VERSION)])
      }
      // Image CDN default off: unset stays unset (the EO reader then reuses
      // the public base); only an explicitly configured base is propagated.
      const edgeoneImageBaseUrl = String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim()
      if (edgeoneImageBaseUrl) {
        envPairs.push(['AIRINGCAL_IMAGE_BASE_URL', edgeoneImageBaseUrl])
      }
      for (const [key, value] of envPairs) {
        const setRes = spawnSyncImpl(
          'edgeone',
          ['makers', 'env', 'set', key, value, '-e', 'production', '-t', token],
          { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
        )
        assertSpawnOk(setRes, `edgeone makers env set ${key}`, secrets)
      }

      const readerUrlMatch = String(deploy.stdout || '').match(/https:\/\/\S*edgeone\S*/i)
      return {
        deployed: true,
        project,
        region,
        createdViaDeploy: true,
        readerUrl: readerUrlMatch ? readerUrlMatch[0].replace(/[.,;)]+$/, '') : null,
      }
    },

    /**
     * Real routing evidence for the image base (review item 5): discover an
     * image hash from the published release, then require every reader
     * deployed in this run to answer `GET /image/{hash}` with a 302 whose
     * Location origin equals `(imageBaseUrl ?? publicBaseUrl)` origin.
     * Mismatch / fetch failure throws (fail closed); a release with zero
     * image hashes returns `skipped-no-images`, which the runner records but
     * never counts as a completed pass.
     */
    async verifyImageRouting(ctx = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('image routing verification failed: fetchImpl required')
      }
      const publicBase = String(plan.publicBaseUrl).replace(/\/+$/, '')
      const imageBase = String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim()
      const expectedOrigin = new URL(imageBase || publicBase).origin

      const readers = []
      if (plan.target === 'cloudflare' || plan.target === 'both') {
        const workerUrl = String(ctx.cloudflareDeploy?.workerUrl ?? '').trim()
        if (!workerUrl) {
          throw new Error(
            'image routing verification failed: cloudflare worker URL missing from the deploy receipt',
          )
        }
        readers.push({ label: 'cloudflare', base: workerUrl.replace(/\/+$/, '') })
      }
      if (plan.target === 'edgeone' || plan.target === 'both') {
        const eoBase =
          String(ctx.edgeoneDeploy?.readerUrl ?? '').trim() ||
          String(env.AIRINGCAL_EDGEONE_READER_URL ?? '').trim()
        if (!eoBase) {
          throw new Error(
            'image routing verification failed: edgeone reader host unknown; set AIRINGCAL_EDGEONE_READER_URL for routing verification',
          )
        }
        readers.push({ label: 'edgeone', base: eoBase.replace(/\/+$/, '') })
      }

      const pointerUrl = `${publicBase}/public/current-release.json`
      const pointerResponse = await fetchImpl(pointerUrl, {
        headers: { 'cache-control': 'no-cache' },
        redirect: 'manual',
      })
      if (!isOkResponse(pointerResponse)) {
        throw new Error(
          `image routing verification failed: pointer fetch ${pointerUrl} -> ${pointerResponse?.status ?? 'no response'}`,
        )
      }
      const pointer = await pointerResponse.json()
      const artifactRef = String(pointer?.artifact_ref ?? '').trim()
      if (!artifactRef) {
        throw new Error(
          'image routing verification failed: current-release.json has no artifact_ref',
        )
      }

      const snapshotUrl = /^https?:\/\//i.test(artifactRef)
        ? artifactRef
        : `${publicBase}/${artifactRef.replace(/^\/+/, '')}`
      const snapshotResponse = await fetchImpl(snapshotUrl, {
        headers: { 'cache-control': 'no-cache' },
        redirect: 'manual',
      })
      if (!isOkResponse(snapshotResponse)) {
        throw new Error(
          `image routing verification failed: snapshot fetch ${snapshotUrl} -> ${snapshotResponse?.status ?? 'no response'}`,
        )
      }
      let snapshot
      try {
        snapshot = await snapshotResponse.json()
      } catch (error) {
        throw new Error(
          `image routing verification failed: snapshot JSON invalid: ${error?.message ?? error}`,
        )
      }

      const hashes = collectReleaseImageHashes(snapshot)
      if (hashes.length === 0) {
        return {
          status: 'skipped-no-images',
          reason: `published release ${artifactRef} references no images/<64-hex>/original hashes; nothing to probe`,
        }
      }
      const hash = hashes[0]

      const receipts = []
      for (const reader of readers) {
        const imageUrl = `${reader.base}/image/${hash}`
        let response
        try {
          response = await fetchImpl(imageUrl, { redirect: 'manual' })
        } catch (error) {
          throw new Error(
            `image routing verification failed: ${reader.label} GET ${imageUrl} errored: ${error?.message ?? error}`,
          )
        }
        const status = Number(response?.status ?? 0)
        const location = headerValue(response, 'location')
        let locationOrigin = null
        if (location) {
          try {
            locationOrigin = new URL(location, reader.base).origin
          } catch {
            locationOrigin = null
          }
        }
        if (status !== 302 || !location || locationOrigin !== expectedOrigin) {
          throw new Error(
            `image routing verification failed: ${reader.label} GET ${imageUrl} -> ${status || 'no response'} location=${location ?? '(none)'}; expected 302 to origin ${expectedOrigin}`,
          )
        }
        receipts.push({ base: reader.base, location, originMatches: true })
      }
      return { hash, readers: receipts }
    },

    async validateImageCdn() {
      return validateImageCdnConfig({
        publicBaseUrl: plan.publicBaseUrl,
        imageBaseUrl: env.AIRINGCAL_IMAGE_BASE_URL || '',
        originHost: plan.publicHost,
      })
    },

    async runSingleWriterTest(ctx = {}) {
      if (ctx.developmentWriterEnabled) {
        throw new Error(
          'Refusing single-writer test while developmentWriterEnabled=true in runner ctx',
        )
      }
      if (String(env.AIRINGCAL_DEPLOY_WRITER_TEST ?? '').trim() !== 'yes') {
        return {
          dispatched: false,
          skipped: true,
          reason:
            'set AIRINGCAL_DEPLOY_WRITER_TEST=yes to run one controlled target=development dispatch after isolation+copy',
        }
      }

      const workflow = plan.writerFreeze?.workflow || 'portable-writer.yml'

      // The writer freeze is lifted ONLY inside this block
      // (enable → repo gate true → dispatch → verify → re-disable). A skipped
      // development job is never accepted as a pass.
      let receipt = null
      const restoreFailures = []
      try {
        runGh(spawnSyncImpl, ['workflow', 'enable', workflow, '--repo', repo], env)

        // Job-level `if` reads repo-level `vars.` (environment-scoped vars are
        // not reliably visible there), so the gate is a repository variable.
        runGh(
          spawnSyncImpl,
          [
            'variable',
            'set',
            DEVELOPMENT_WRITER_GATE_VAR,
            '--repo',
            repo,
            '--body',
            'true',
          ],
          env,
        )

        const before = parseGhJson(
          runGh(
            spawnSyncImpl,
            [
              'run',
              'list',
              `--workflow=${workflow}`,
              '--repo',
              repo,
              '--event',
              'workflow_dispatch',
              '--json',
              'databaseId,createdAt',
              '--limit',
              '1',
            ],
            env,
          ),
          'gh run list (pre-dispatch)',
        )
        const previousRunId =
          Array.isArray(before) && before.length > 0 ? String(before[0].databaseId) : null

        runGh(
          spawnSyncImpl,
          ['workflow', 'run', workflow, '--repo', repo, '-f', 'target=development'],
          env,
        )

        const deadline = nowImpl() + WRITER_TEST_DEADLINE_MS
        let runId = null
        while (runId === null) {
          if (nowImpl() > deadline) {
            throw new Error(
              `single-writer test: dispatched ${workflow} run did not appear before the deadline`,
            )
          }
          const listed = parseGhJson(
            runGh(
              spawnSyncImpl,
              [
                'run',
                'list',
                `--workflow=${workflow}`,
                '--repo',
                repo,
                '--event',
                'workflow_dispatch',
                '--json',
                'databaseId,createdAt,status',
                '--limit',
                '5',
              ],
              env,
            ),
            'gh run list (dispatch discovery)',
          )
          const newest = Array.isArray(listed) && listed.length > 0 ? listed[0] : null
          if (newest && String(newest.databaseId) !== previousRunId) {
            runId = String(newest.databaseId)
          } else {
            await sleepImpl(WRITER_TEST_POLL_MS)
          }
        }

        const url = `https://github.com/${repo}/actions/runs/${runId}`
        let view = null
        for (;;) {
          view = parseGhJson(
            runGh(
              spawnSyncImpl,
              ['run', 'view', runId, '--repo', repo, '--json', 'status,conclusion,jobs'],
              env,
            ),
            'gh run view',
          )
          if (String(view?.status ?? '') === 'completed') break
          if (nowImpl() > deadline) {
            throw new Error(`single-writer test: run ${url} did not complete before the deadline`)
          }
          await sleepImpl(WRITER_TEST_POLL_MS)
        }

        const conclusion = String(view?.conclusion ?? '')
        const jobs = Array.isArray(view?.jobs) ? view.jobs : []
        const devJob = jobs.find(
          (job) => String(job?.name ?? '').trim().toLowerCase() === 'development',
        )
        const jobConclusion = devJob ? String(devJob.conclusion ?? '') : null

        if (!devJob) {
          throw new Error(
            `single-writer test: development job not found in run ${url} — cannot prove a pass`,
          )
        }
        if (jobConclusion === 'skipped' || jobConclusion === 'neutral') {
          throw new Error(
            'single-writer test skipped (writer gate not visible) — not a pass',
          )
        }
        if (conclusion !== 'success' || jobConclusion !== 'success') {
          throw new Error(
            `single-writer test failed (run=${conclusion || 'unknown'}, development job=${jobConclusion || 'unknown'}): ${url}`,
          )
        }
        receipt = {
          dispatched: true,
          runId: Number(runId),
          url,
          conclusion,
          jobConclusion,
        }
      } finally {
        // Always restore the freeze (gate off + workflow disabled), pass or fail.
        for (const args of [
          ['variable', 'set', DEVELOPMENT_WRITER_GATE_VAR, '--repo', repo, '--body', 'false'],
          ['workflow', 'disable', workflow, '--repo', repo],
        ]) {
          try {
            runGh(spawnSyncImpl, args, env)
          } catch (error) {
            restoreFailures.push(error instanceof Error ? error.message : String(error))
          }
        }
      }
      if (restoreFailures.length > 0) {
        throw new Error(
          `single-writer test: writer freeze restore FAILED (${restoreFailures.join('; ')}) — re-disable ${workflow} manually`,
        )
      }
      return { ...receipt, restored: true }
    },
  }
}
