/**
 * Live Cloudflare / GitHub / EdgeOne I/O adapters for deploy-env --apply.
 *
 * Injectable via createLiveDevelopmentApplyIo({ spawnSyncImpl, fetchImpl, … }).
 * Unit tests must not hit live cloud — pass spawn/fetch doubles.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawnSync as defaultSpawnSync } from 'node:child_process'

import {
  ALLOWED_REPOSITORY,
  DEVELOPMENT_DEFAULTS,
  DEVELOPMENT_SECRET_KEYS,
  DEVELOPMENT_VARIABLE_KEYS,
  PRODUCTION_DEFAULTS,
  PRODUCTION_SECRET_KEYS,
  PRODUCTION_VARIABLE_KEYS,
  assertCheckpointBucketPrivate,
  normalizeCorsAllowedMethods,
  parseWranglerWhoamiAccounts,
  parseWranglerWhoamiJson,
  redactSecrets,
  validateImageCdnConfig,
  validateProductionReleaseIdentity,
} from './deploy-env-lib.mjs'
import { isAmbiguousTransportError } from './mutation-ledger.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromNodeJobs = createRequire(join(ROOT, 'apps/node-jobs/package.json'))

const CF_API = 'https://api.cloudflare.com/client/v4'
const API_TIMEOUT_MS = 15_000
const WRANGLER = ['pnpm', 'exec', 'wrangler']
const ENV_FILE_NULL = ['--env-file', '/dev/null']

/** Official bucket-scoped R2 object permission group (Cloudflare docs). */
const R2_BUCKET_ITEM_WRITE = 'Workers R2 Storage Bucket Item Write'

/** Official single-bucket resource key: <acct>_default_<bucket> (flat form). */
function r2BucketResourceKey(accountId, bucketName) {
  return `com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`
}

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
  err.errorCategory = 'permission-denied'
  err.code = 'TOKEN_CREATE_DENIED'
  err.exitCode = 2
  return err
}

function taggedError(message, { code = null, errorCategory = 'internal-error', missingScopes, exitCode, cleanupFailed } = {}) {
  const err = new Error(message)
  if (code) err.code = code
  if (errorCategory) err.errorCategory = errorCategory
  if (Array.isArray(missingScopes) && missingScopes.length > 0) err.missingScopes = missingScopes
  if (exitCode !== undefined) err.exitCode = exitCode
  if (cleanupFailed !== undefined) err.cleanupFailed = cleanupFailed
  return err
}

const NOOP_LEDGER_HANDLE = Object.freeze({
  confirm() {},
  alreadyExists() {},
  fail() {},
  unknown() {},
  compensationFailed() {},
})

function ledgerFor(ctx) {
  if (ctx?.ledger && typeof ctx.ledger.begin === 'function') return ctx.ledger
  return {
    begin: () => NOOP_LEDGER_HANDLE,
    recordIntended: () => {},
  }
}

function classifyCfHttpError(error, defaultCategory = 'provider-incompatibility') {
  if (error?.errorCategory) return error.errorCategory
  const status = Number(error?.status ?? error?.$metadata?.httpStatusCode)
  const msg = String(error?.message ?? '')
  if (status === 401 || status === 403 || /unauthoriz|forbidden|denied|authentication error/i.test(msg)) {
    return 'permission-denied'
  }
  if (isAmbiguousTransportError(error) || status === 429 || (Number.isFinite(status) && status >= 500)) {
    return 'transport-failure'
  }
  return defaultCategory
}

/**
 * #208 Review Finding 2: A prior local inventory establishes bucket ownership
 * ONLY when it matches environment/bucket/account AND contains affirmative
 * evidence that AiringCal created, adopted, or deployed that bucket — never
 * from a failed attempt that was itself refused for unproven ownership.
 */
export function hasAffirmativeBucketOwnership(priorInventory, bucket, accountId = '') {
  if (!priorInventory || typeof priorInventory !== 'object') return false
  if (priorInventory.environment !== 'production' || priorInventory.bucket !== bucket) return false
  const normalizedAcct = String(accountId ?? '').trim().toLowerCase()
  const priorAcct = String(priorInventory.cloudflare?.accountId ?? '').trim().toLowerCase()
  if (!normalizedAcct || !priorAcct || normalizedAcct !== priorAcct) return false

  const deployedVerdicts = new Set(['READY', 'DEPLOYED', 'AWAITING_FIRST_SYNC', 'SYNC_FAILED', 'VERIFICATION_FAILED'])
  if (deployedVerdicts.has(priorInventory.deployment?.verdict)) return true
  if (priorInventory.resources?.bucket?.ownershipConfirmed === true) return true

  const receipts = Array.isArray(priorInventory.mutationReceipts) ? priorInventory.mutationReceipts : []
  for (const receipt of receipts) {
    const executed = Array.isArray(receipt?.mutationsExecuted) ? receipt.mutationsExecuted : []
    if (
      executed.includes('r2-bucket-create') ||
      executed.includes('ensure-bucket') ||
      executed.includes('ensure-bucket-empty')
    ) {
      return true
    }
    const ledgerEntries = Array.isArray(receipt?.mutations) ? receipt.mutations : []
    if (
      ledgerEntries.some(
        (m) => m?.op === 'r2-bucket-create' && (m.status === 'confirmed-success' || m.status === 'already-exists'),
      )
    ) {
      return true
    }
  }
  return false
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

/**
 * `edgeone makers env rm <key>` is idempotent from our point of view: an
 * absent project variable is the desired end state. Non-zero exits whose
 * output only says the key was not found are tolerated; spawn failures and
 * every other error (auth, network, unknown flag) still throw.
 */
function assertEdgeoneEnvRmOk(result, label, secrets = []) {
  if (!result || result.status === 0) return result
  const out = redactSecrets(`${result.stderr || ''}\n${result.stdout || ''}`.trim(), secrets)
  if (!result.error && /not\s*found|does\s*not\s*exist|no\s*such|not\s*set|unknown\s*(?:variable|key|name)|not\s*configured/i.test(out)) {
    return result
  }
  return assertSpawnOk(result, label, secrets)
}

/**
 * Parse a pulled EdgeOne `env pull` dotenv file (KEY=VALUE lines, optional
 * quotes / comments / blank lines) into a plain object.
 */
function parseEdgeoneEnvFile(content) {
  const out = {}
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

/**
 * Prefer the `url` from `--json` deploy output; fall back to the legacy
 * stdout URL regex for CLIs that print a human-readable deployment line.
 */
function parseEdgeoneDeployUrl(stdout) {
  const out = String(stdout || '').trim()
  if (out) {
    try {
      const parsed = JSON.parse(out)
      const url = parsed?.url ?? parsed?.data?.url ?? parsed?.result?.url
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        return url.replace(/[.,;)]+$/, '')
      }
    } catch {
      // Not JSON (legacy CLI output): fall through to the regex below.
    }
  }
  const match =
    out.match(/https:\/\/\S*edgeone\S*/i) || out.match(/https:\/\/[^\s"')]+/i)
  return match ? match[0].replace(/[.,;)]+$/, '') : null
}

/**
 * Transient-network retry hardening. This machine ↔ Cloudflare intermittently
 * resets connections; a single failed verify / `wrangler r2 bucket list` /
 * isolation probe must not fall through to the scoped-token path nor get
 * misclassified as a missing scope. Retries are bounded (500ms, 2000ms for
 * API/fetch; 1s, 3s for CLI spawns) and ONLY apply to network-ish failures —
 * auth/scope/business errors keep failing immediately and fail-closed.
 */
const NETWORK_RETRY_BACKOFF_MS = [500, 2000]
const SPAWN_RETRY_BACKOFF_MS = [1000, 3000]
const RETRIABLE_CF_STATUSES = new Set([429, 500, 502, 503, 504])

/** Messages emitted by wrangler/gh when their own fetch layer hit the network. */
const TRANSIENT_NETWORK_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|could not resolve|connectivity|TLS|network|ENOTFOUND|EAI_AGAIN|connection|(?:^|\s|:)EOF(?:\s|$|:)|unexpected EOF/i

/** probeToken label for exhausted-but-transient failures (never a scope claim). */
const TRANSIENT_NETWORK_NOTE =
  'transient Cloudflare network failure (retried; re-run apply if it persists)'

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A thrown (not HTTP-answered) failure that looks like connectivity, not policy. */
function isThrownNetworkError(error) {
  const name = String(error?.name ?? '')
  if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError') return true
  const code = String(error?.code ?? '')
  if (
    code === 'ABORT_ERR' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_SOCKET'
  ) {
    return true
  }
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /timed out|timeout|aborted|fetch failed|socket hang up/i.test(msg) || TRANSIENT_NETWORK_RE.test(msg)
}

/** cfApi classifier: thrown network OR 429/5xx; auth/404/business never. */
function isRetriableCfApiError(error) {
  const status = Number(error?.status)
  if (Number.isFinite(status)) return RETRIABLE_CF_STATUSES.has(status)
  return isThrownNetworkError(error)
}

function isTransientSpawnFailure(error) {
  return (
    Boolean(error?.transientNetwork) ||
    TRANSIENT_NETWORK_RE.test(String(error?.message ?? error ?? ''))
  )
}

async function retryWithBackoff(fn, { attempts, isRetriable, sleep, delaysMs }) {
  for (let i = 0; ; i += 1) {
    try {
      return await fn()
    } catch (error) {
      if (i + 1 >= attempts || !isRetriable(error)) throw error
      await sleep(delaysMs[Math.min(i, delaysMs.length - 1)])
    }
  }
}

/**
 * Run `fn` up to `attempts` times, sleeping 500ms then 2000ms (bounded)
 * between retriable failures. Non-retriable errors rethrow immediately.
 * Callers MUST pass an `isRetriable` predicate; without one nothing retries.
 */
export async function withNetworkRetry(
  fn,
  { attempts = 3, isRetriable = () => false, sleep = defaultSleep } = {},
) {
  return retryWithBackoff(fn, {
    attempts,
    isRetriable,
    sleep,
    delaysMs: NETWORK_RETRY_BACKOFF_MS,
  })
}

async function spawnWithNetworkRetry(spawnOnce, label, secrets, opts = {}) {
  return retryWithBackoff(
    async () => {
      const result = await spawnOnce()
      if (result && result.status !== 0 && !result.error) {
        const out = `${result.stderr || ''}\n${result.stdout || ''}`.trim()
        if (TRANSIENT_NETWORK_RE.test(out)) {
          const err = new Error(
            `${label} failed (exit ${result.status}): ${redactSecrets(out, secrets) || '(no output)'}`,
          )
          err.transientNetwork = true
          throw err
        }
      }
      return assertSpawnOk(result, label, secrets)
    },
    {
      attempts: opts.attempts ?? 3,
      isRetriable: (error) => Boolean(error?.transientNetwork),
      sleep: opts.sleep ?? defaultSleep,
      delaysMs: SPAWN_RETRY_BACKOFF_MS,
    },
  )
}

export async function runWrangler(spawnSyncImpl, subArgs, env, opts = {}) {
  const secrets = secretList(env)
  const args = [...WRANGLER.slice(1), ...subArgs, ...ENV_FILE_NULL]
  return spawnWithNetworkRetry(
    () =>
      spawnSyncImpl(WRANGLER[0], args, {
        encoding: 'utf8',
        cwd: opts.cwd ?? ROOT,
        env: {
          ...process.env,
          ...env,
          CLOUDFLARE_API_TOKEN: tokenFromEnv(env) || process.env.CLOUDFLARE_API_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: accountIdFrom(env) || process.env.CLOUDFLARE_ACCOUNT_ID,
        },
        input: opts.input,
      }),
    `wrangler ${subArgs.join(' ')}`,
    secrets,
    opts,
  )
}

export async function runGh(spawnSyncImpl, args, env, opts = {}) {
  const secrets = secretList(env)
  return spawnWithNetworkRetry(
    () =>
      spawnSyncImpl('gh', args, {
        encoding: 'utf8',
        cwd: opts.cwd ?? ROOT,
        env: { ...process.env, ...env },
        input: opts.input,
      }),
    `gh ${args.join(' ')}`,
    secrets,
    opts,
  )
}

/**
 * GitHub refuses `gh workflow enable|disable` when the workflow already sits
 * in the desired state (HTTP 403: "Unable to disable a workflow that is not
 * active" / "Unable to enable a workflow that is not disabled"). A re-run of
 * apply while the freeze holds lands in exactly that state, so the refusal IS
 * success. Only those known state messages count as a no-op; every other
 * failure — auth, network after runGh's own retries, unknown flags —
 * rethrows unchanged so freeze/restore stay fail-closed. This wrapper is for
 * enable/disable call sites ONLY; runGh itself stays strict for everyone.
 */
const WORKFLOW_TOGGLE_NOOP_RE = /not active|not disabled|already (?:active|disabled)/i

async function runGhWorkflowToggle(spawnSyncImpl, args, env) {
  try {
    await runGh(spawnSyncImpl, args, env)
    return false
  } catch (error) {
    if (WORKFLOW_TOGGLE_NOOP_RE.test(String(error?.message ?? error))) return true
    throw error
  }
}

async function cfApiOnce(fetchImpl, token, path, init) {
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
    err.path = path
    // A `10000` on a `/zones/...` request is the shape a token produces when
    // it can read the zone but lacks the fine-grained Cache Rules / WAF Custom
    // Rules / DNS Edit scopes. Mark it so callers can surface an actionable
    // missing-capability message instead of the opaque Cloudflare code.
    if (path.startsWith('/zones/') && errors.some((e) => Number(e?.code) === 10000)) {
      err.zoneScopeHint =
        'Cloudflare 10000 on a /zones/... request: token likely lacks Cache Rules / WAF Custom Rules / DNS Edit scopes'
    }
    throw err
  }
  return body
}

export async function cfApi(fetchImpl, token, path, init = {}, retryOpts = {}) {
  return withNetworkRetry(() => cfApiOnce(fetchImpl, token, path, init), {
    isRetriable: isRetriableCfApiError,
    ...retryOpts,
  })
}

/** Actionable detail shared by the zone-ruleset adapters when scopes are missing. */
export const ZONE_SCOPE_CAPABILITY_MESSAGE =
  'Cloudflare token lacks zone-scoped Cache Rules / WAF Custom Rules / DNS Edit permissions (add them in dash.cloudflare.com/profile/api-tokens, then re-run apply; already-created bucket and custom domain are reused)'

/**
 * True for the Cloudflare `10000 Authentication error` an API token produces
 * on a `/zones/...` request it cannot edit (missing fine-grained Cache Rules /
 * WAF Custom Rules / DNS Edit scopes). `cfApi` marks these with `zoneScopeHint`.
 * Genuine network failures, other auth 4xx, and isolation aborts are
 * deliberately NOT matched so retry/fail-closed semantics stay unchanged.
 */
export function isZoneScopeError(error) {
  if (!error || typeof error !== 'object') return false
  const zoneScoped =
    Boolean(error.zoneScopeHint) || /^\/zones\//.test(String(error.path ?? ''))
  if (!zoneScoped) return false
  const errors = Array.isArray(error.errors) ? error.errors : []
  const structured = errors.some(
    (e) =>
      Number(e?.code) === 10000 &&
      /authentication error/i.test(String(e?.message ?? '')),
  )
  const message = String(error.message ?? '')
  const flattened =
    /\b10000\b/.test(message) && /authentication error/i.test(message)
  return structured || flattened
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function s3EndpointFor(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

export function createDefaultObjectStore(config) {
  const { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } =
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
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
      return { deleted: true }
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

const DEFAULT_COPY_CONCURRENCY = 8
const COPY_PROGRESS_INTERVAL = 100

/** A progress line carries only counts + the source bucket name — never keys, bodies, or secrets. */
export function formatCopyProgress({ sourceBucket, done, total, copied, skipped }) {
  return `[deploy-env] copy ${sourceBucket}: ${done}/${total} (copied=${copied}, skipped=${skipped})`
}

function defaultCopyProgressWriter(line) {
  process.stderr.write(`${line}\n`)
}

/**
 * Copy every key under `prefixes` from `sourceBucket` to `destBucket` using a
 * small bounded worker pool (no new dependency). The old fully sequential loop
 * made 4 S3 calls per object and took >1h for 2029 staging images (round 16
 * timed out mid-copy). Injectable `createObjectStore` / `write` keep it
 * unit-testable with deterministic store doubles; no retries beyond the AWS SDK.
 */
export async function copyPrefixes({
  createObjectStore,
  s3Creds,
  sourceBucket,
  destBucket,
  prefixes,
  concurrency = DEFAULT_COPY_CONCURRENCY,
  progressInterval = COPY_PROGRESS_INTERVAL,
  write = defaultCopyProgressWriter,
}) {
  const source = createObjectStore({ ...s3Creds, bucket: sourceBucket })
  const dest = createObjectStore({ ...s3Creds, bucket: destBucket })
  let copied = 0
  let skipped = 0
  try {
    // Flatten all keys across every prefix so one bounded pool covers them all.
    const keys = []
    for (const prefix of prefixes) {
      for (const key of await source.list(prefix)) keys.push(key)
    }
    const total = keys.length
    let done = 0
    let cursor = 0
    let aborted = false

    const processKey = async (key) => {
      if (key.endsWith('/')) return
      const srcHead = await source.head(key)
      if (!srcHead) return
      const dstHead = await dest.head(key)
      if (
        dstHead &&
        Number(dstHead.size) === Number(srcHead.size) &&
        normalizeLooseEtag(dstHead.etag) === normalizeLooseEtag(srcHead.etag)
      ) {
        skipped += 1
        return
      }
      const obj = await source.get(key)
      if (!obj?.body) return
      await dest.put(key, obj.body, {
        contentType: obj.contentType ?? srcHead.contentType ?? undefined,
      })
      copied += 1
    }

    const worker = async () => {
      while (!aborted) {
        const index = cursor++
        if (index >= total) return
        try {
          await processKey(keys[index])
        } catch (error) {
          // Stop scheduling new keys; in-flight keys still settle through the
          // Promise.allSettled below. Never silently continue past an error.
          aborted = true
          throw error
        }
        done += 1
        if (done % progressInterval === 0) {
          write(formatCopyProgress({ sourceBucket, done, total, copied, skipped }))
        }
      }
    }

    const workerCount = Math.max(0, Math.min(concurrency, total))
    const settled = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    )
    const failed = settled.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
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
  const repo = plan.repository || DEVELOPMENT_DEFAULTS.repository
  // The adapter is environment-aware: the same step machinery serves the
  // development cutover and the production clean bootstrap, but production
  // refuses every staging-coupled step (copy / freeze / writer test) and
  // targets the production GitHub Environment + AIRINGCAL_PRODUCTION_* names.
  const isProduction = plan.env === 'production'

  /** @type {{ accessKeyId: string, secretAccessKey: string, endpoint: string, region: string, derived: boolean } | null} */
  let s3Creds = null
  /** @type {((ctx?: object) => Promise<{ cleaned: boolean, error: Error | null }>) | null} */
  let pendingFreshWriterCleanup = null

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
        // Credential rejection marker (AccessDenied / InvalidAccessKeyId /
        // SignatureDoesNotMatch and this wrapped variant): lets the override
        // branch fall through to self-derivation. Network/unknown errors
        // never carry it and stay fail-closed.
        err.s3Rejected = true
        throw err
      }
      throw error
    } finally {
      store.close?.()
    }
  }

  async function verifyRepositoryPreflight(_ctx = {}) {
    const isNonDefaultRepo = repo && repo !== ALLOWED_REPOSITORY
    if (plan.repositoryExplicit !== true && !isNonDefaultRepo && String(env.AIRINGCAL_VERIFY_REPOSITORY ?? '').trim() !== 'yes') {
      return { ok: true, repository: repo, skipped: true }
    }
    const repoRes = spawnSyncImpl('gh', ['api', `repos/${repo}`], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...env },
    })
    const repoOut = redactSecrets(`${repoRes?.stderr || ''}\n${repoRes?.stdout || ''}`.trim(), secrets)
    if (repoRes?.error || TRANSIENT_NETWORK_RE.test(repoOut)) {
      throw taggedError(`Failed to inspect GitHub repository "${repo}": ${repoRes?.error?.message ?? repoOut}`, {
        code: 'REPOSITORY_TRANSPORT_ERROR',
        errorCategory: 'transport-failure',
        exitCode: 1,
      })
    }
    if (repoRes?.status !== 0) {
      const isNotFound = /404|Not Found/i.test(repoOut)
      throw taggedError(
        isNotFound
          ? `Target GitHub repository "${repo}" was not found or is not accessible (HTTP 404)`
          : `Permission denied inspecting GitHub repository "${repo}": ${repoOut}`,
        {
          code: isNotFound ? 'REPOSITORY_NOT_FOUND' : 'REPOSITORY_PERMISSION_DENIED',
          errorCategory: 'permission-denied',
          exitCode: 2,
        },
      )
    }
    let repoMeta = null
    try { repoMeta = JSON.parse(String(repoRes.stdout ?? '{}')) } catch { repoMeta = null }
    if (repoMeta?.permissions && repoMeta.permissions.admin !== true && repoMeta.permissions.push !== true) {
      throw taggedError(
        `Authenticated GitHub account does not have write/admin permissions on "${repo}"`,
        {
          code: 'REPOSITORY_PERMISSION_DENIED',
          errorCategory: 'permission-denied',
          exitCode: 2,
        },
      )
    }
    const wfRes = spawnSyncImpl('gh', ['api', `repos/${repo}/actions/workflows/portable-writer.yml`], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, ...env },
    })
    if (wfRes?.status !== 0) {
      throw taggedError(
        `Required workflow "portable-writer.yml" is not available on repository "${repo}"`,
        {
          code: 'WORKFLOW_UNAVAILABLE',
          errorCategory: 'resource-conflict',
          exitCode: 2,
        },
      )
    }
    return {
      ok: true,
      repository: repo,
      defaultBranch: repoMeta?.default_branch ?? null,
    }
  }

  return {
    /**
     * #195: the setup wizard's verifier needs the SAME S3 credentials the
     * apply derived. Read-only accessor — never logged, never persisted.
     */
    s3Credentials() {
      return s3Creds
        ? {
          accessKeyId: s3Creds.accessKeyId,
          secretAccessKey: s3Creds.secretAccessKey,
          endpoint: s3Creds.endpoint,
          // Actual source/scope — not the desired canonical name.
          source: s3Creds.source ?? 'unknown',
          scope: s3Creds.scope ?? 'unverified',
          tokenName: s3Creds.tokenName ?? null,
          tokenId: s3Creds.tokenId ?? null,
        }
        : null
    },

    verifyRepositoryPreflight,

    /**
     * Amendment A, B & C: Pre-mutation verification of an existing installation before `update`.
     * Inspects:
     *  1. Target repository permissions & workflow availability (when verifiable)
     *  2. Target R2 bucket existence & account ownership
     *  3. Existing Cloudflare Worker identity and actual R2 binding (`AIRINGCAL_R2` -> `bucket`)
     *  4. GitHub Environment existence, variables (`R2_BUCKET`, `CLOUDFLARE_ACCOUNT_ID`, `PRIMARY_USER_ID`, `PUBLIC_BASE_URL`), and secrets (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BANGUMI_TOKEN`)
     *  5. Local inventory consistency (refuses contradictory local inventory)
     *  6. Existing Writer token status & bucket-scoped policy via Cloudflare API
     *  7. Existing release pointer / manifest / snapshot state (via S3 if override provided, or via verified bound Worker `/public/current-release.json`)
     *
     * Never deploys a Worker first and uses the newly deployed Worker as sole proof!
     */
    async verifyExistingInstallation(ctx = {}) {
      const accountId = accountIdFrom(env, plan) || ctx.accountId
      const parentToken = tokenFromEnv(env)
      const envName = isProduction ? 'production' : 'development'
      const prefix = isProduction ? 'AIRINGCAL_PRODUCTION_' : 'AIRINGCAL_DEVELOPMENT_'
      const workerName = plan.cloudflareWorkerName || (isProduction ? PRODUCTION_DEFAULTS.workerName : DEVELOPMENT_DEFAULTS.workerName)

      if (plan.publicOriginMode === 'bucket-domain' || String(env.AIRINGCAL_PUBLIC_ORIGIN_MODE ?? '').trim() === 'bucket-domain') {
        throw taggedError(
          'Legacy bucket-domain origin mode is unsupported in v3.0.0 update flows; migrate explicitly to worker origin mode before updating.',
          {
            code: 'UNSUPPORTED_LEGACY_CONFIG',
            errorCategory: 'resource-conflict',
            exitCode: 2,
          },
        )
      }

      // 1. Repository preflight
      await verifyRepositoryPreflight(ctx)

      // 2. Local inventory consistency check (never blindly trust local inventory; fail closed if it contradicts!)
      const priorInv = ctx?.priorInventory
      if (priorInv && typeof priorInv === 'object') {
        const invRepo = String(priorInv.repository ?? '').trim()
        const invAcct = String(priorInv.cloudflare?.accountId ?? '').trim().toLowerCase()
        const invBucket = String(priorInv.bucket ?? '').trim()
        const invUser = String(priorInv.bangumi?.primaryUserId ?? '').trim()
        const curUser = String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim()
        if (invRepo && invRepo.toLowerCase() !== repo.toLowerCase()) {
          throw taggedError(
            `Local inventory repository mismatch: inventory records "${invRepo}" while target repository is "${repo}". Refusing update.`,
            { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
        if (invAcct && accountId && invAcct !== accountId.toLowerCase()) {
          throw taggedError(
            `Local inventory Cloudflare account mismatch: inventory records "${invAcct}" while active account is "${accountId}". Refusing update.`,
            { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
        if (invBucket && invBucket !== bucket) {
          throw taggedError(
            `Local inventory bucket mismatch: inventory records "${invBucket}" while target bucket is "${bucket}". Refusing update.`,
            { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
        if (invUser && curUser && invUser !== curUser && String(env.AIRINGCAL_ALLOW_IDENTITY_CHANGE ?? '').trim() !== 'yes') {
          throw taggedError(
            `Bangumi primaryUserId mismatch: local inventory records "${invUser}" while current credentials resolve "${curUser}". Refusing update without explicit AIRINGCAL_ALLOW_IDENTITY_CHANGE=yes.`,
            { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
      }

      // 3. Target R2 bucket must exist in the selected account
      const info = spawnSyncImpl(
        WRANGLER[0],
        [...WRANGLER.slice(1), 'r2', 'bucket', 'info', bucket, '--json', ...ENV_FILE_NULL],
        {
          encoding: 'utf8',
          cwd: ROOT,
          env: {
            ...process.env,
            ...env,
            CLOUDFLARE_API_TOKEN: parentToken,
            CLOUDFLARE_ACCOUNT_ID: accountId,
          },
        },
      )
      const infoOut = redactSecrets(`${info?.stderr || ''}\n${info?.stdout || ''}`.trim(), secrets)
      if (info?.error || TRANSIENT_NETWORK_RE.test(infoOut)) {
        throw taggedError(
          `Cannot verify existing R2 bucket "${bucket}" due to transport failure: ${info?.error?.message ?? infoOut}`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'transport-failure', exitCode: 1 },
        )
      }
      if (info?.status !== 0) {
        if (/401|403|Authentication error|Unauthorized|permission denied/i.test(infoOut)) {
          throw taggedError(
            `Cannot verify existing R2 bucket "${bucket}" due to permission error: ${infoOut}`,
            { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'permission-denied', exitCode: 2 },
          )
        }
        throw taggedError(
          `Update requires an existing initialized R2 bucket "${bucket}", but it does not exist in account ${accountId}`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      let infoMeta = null
      try { infoMeta = JSON.parse(String(info.stdout ?? '').trim()) } catch { infoMeta = null }
      const observedBucket = {
        name: bucket,
        accountId: accountId || null,
        exists: true,
        created: false,
        creationDate: infoMeta?.creation_date ?? infoMeta?.creationDate ?? null,
        location: infoMeta?.location ?? null,
      }

      // 4. Existing Cloudflare Worker identity & actual R2 binding verification
      let workerScripts = null
      try {
        const scriptsBody = await cfApi(fetchImpl, parentToken, `/accounts/${encodeURIComponent(accountId)}/workers/scripts`)
        workerScripts = Array.isArray(scriptsBody?.result) ? scriptsBody.result : []
      } catch (error) {
        const category = classifyCfHttpError(error, 'transport-failure')
        throw taggedError(
          `Cannot verify existing Cloudflare Worker "${workerName}": ${redactSecrets(error?.message ?? String(error), secrets)}`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: category, exitCode: category === 'permission-denied' ? 2 : 1 },
        )
      }
      const existingWorker = workerScripts.find((w) => String(w?.id ?? w?.name ?? '') === workerName)
      if (!existingWorker) {
        throw taggedError(
          `Update requires existing Cloudflare Worker "${workerName}" to be deployed in account ${accountId}, but it was not found.`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      let workerSettings = null
      try {
        const settingsBody = await cfApi(
          fetchImpl,
          parentToken,
          `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
        )
        workerSettings = settingsBody?.result ?? null
      } catch (error) {
        const category = classifyCfHttpError(error, 'transport-failure')
        throw taggedError(
          `Cannot read R2 bindings for Worker "${workerName}": ${redactSecrets(error?.message ?? String(error), secrets)}`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: category, exitCode: category === 'permission-denied' ? 2 : 1 },
        )
      }
      if (!workerSettings || !Array.isArray(workerSettings.bindings)) {
        throw taggedError(
          `Cannot verify R2 bindings for Worker "${workerName}" (settings payload missing bindings array). Refusing update without positive binding proof.`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'provider-incompatibility', exitCode: 1 },
        )
      }
      const r2Binding = workerSettings.bindings.find(
        (b) => (b?.type === 'r2_bucket' || b?.name === 'AIRINGCAL_R2') && (b?.name === 'AIRINGCAL_R2' || b?.bucket_name),
      )
      const boundBucket = String(r2Binding?.bucket_name ?? r2Binding?.bucketName ?? '').trim()
      if (!r2Binding || boundBucket !== bucket) {
        throw taggedError(
          `Existing Cloudflare Worker "${workerName}" is bound to R2 bucket "${boundBucket || '<none>'}" instead of "${bucket}". Refusing update.`,
          { code: 'WORKER_BINDING_MISMATCH', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }

      // 5. GitHub Environment & variable/secret consistency verification
      const envRes = spawnSyncImpl('gh', ['api', `repos/${repo}/environments/${envName}`], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, ...env },
      })
      const envOut = redactSecrets(`${envRes?.stderr || ''}\n${envRes?.stdout || ''}`.trim(), secrets)
      if (envRes?.error || TRANSIENT_NETWORK_RE.test(envOut)) {
        throw taggedError(
          `Cannot verify GitHub Environment "${envName}" in "${repo}": ${envRes?.error?.message ?? envOut}`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'transport-failure', exitCode: 1 },
        )
      }
      if (envRes?.status !== 0) {
        if (/404|Not Found/i.test(envOut)) {
          throw taggedError(
            `Update requires existing GitHub Environment "${envName}" in "${repo}", but it does not exist.`,
            { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
        throw taggedError(
          `Cannot read GitHub Environment "${envName}" in "${repo}": ${envOut}`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'permission-denied', exitCode: 2 },
        )
      }

      const readEnvVar = (varName) => {
        const r = spawnSyncImpl(
          'gh',
          ['api', `repos/${repo}/environments/${envName}/variables/${varName}`, '--jq', '.value'],
          { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
        )
        if (r?.status === 0) {
          const raw = String(r.stdout ?? '').trim()
          try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object' && 'value' in parsed) return String(parsed.value).trim()
          } catch { /* jq output is already raw value */ }
          return raw
        }
        return null
      }
      const remoteBucketVar = readEnvVar(`${prefix}R2_BUCKET`)
      const remoteAcctVar = readEnvVar(`${prefix}CLOUDFLARE_ACCOUNT_ID`)
      const remoteUserVar = readEnvVar(`${prefix}PRIMARY_USER_ID`)
      const remotePublicBaseVar = readEnvVar(`${prefix}PUBLIC_BASE_URL`)

      if (remoteBucketVar && remoteBucketVar !== bucket) {
        throw taggedError(
          `GitHub Environment "${envName}" variable ${prefix}R2_BUCKET is "${remoteBucketVar}", which conflicts with target bucket "${bucket}". Refusing update.`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      if (remoteAcctVar && accountId && remoteAcctVar.toLowerCase() !== accountId.toLowerCase()) {
        throw taggedError(
          `GitHub Environment "${envName}" variable ${prefix}CLOUDFLARE_ACCOUNT_ID is "${remoteAcctVar}", which conflicts with active account "${accountId}". Refusing update.`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      const currentUserId = String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim()
      if (remoteUserVar && currentUserId && remoteUserVar !== currentUserId && String(env.AIRINGCAL_ALLOW_IDENTITY_CHANGE ?? '').trim() !== 'yes') {
        throw taggedError(
          `GitHub Environment "${envName}" variable ${prefix}PRIMARY_USER_ID is "${remoteUserVar}", which conflicts with Bangumi user "${currentUserId}". Refusing update without AIRINGCAL_ALLOW_IDENTITY_CHANGE=yes.`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      const plannedBase = String(plan.publicBaseUrl || plan.workerOrigin || '').trim().replace(/\/+$/, '')
      if (
        remotePublicBaseVar &&
        plannedBase &&
        remotePublicBaseVar.replace(/\/+$/, '') !== plannedBase &&
        String(env.AIRINGCAL_ALLOW_DOMAIN_CHANGE ?? '').trim() !== 'yes'
      ) {
        throw taggedError(
          `GitHub Environment "${envName}" variable ${prefix}PUBLIC_BASE_URL is "${remotePublicBaseVar}", which differs from planned "${plannedBase}". Refusing silent custom domain / origin change during update without AIRINGCAL_ALLOW_DOMAIN_CHANGE=yes.`,
          { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }

      const secretListRes = spawnSyncImpl(
        'gh',
        ['secret', 'list', '--env', envName, '--repo', repo, '--json', 'name', '--jq', '.[].name'],
        { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
      )
      if (secretListRes?.status !== 0) {
        throw taggedError(
          `Cannot list secrets in GitHub Environment "${envName}" on "${repo}"`,
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'permission-denied', exitCode: 2 },
        )
      }
      const existingSecrets = new Set(
        String(secretListRes.stdout ?? '')
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      )
      const hasGhS3Secrets =
        existingSecrets.has(`${prefix}S3_ACCESS_KEY_ID`) &&
        existingSecrets.has(`${prefix}S3_SECRET_ACCESS_KEY`)

      // 6. Amendment B: Writer credential presence, reuse, scope verification & runtime verification
      const overrideId = String(env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()
      const overrideSecret = String(env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()
      const rotationId = String(env.AIRINGCAL_WRITER_TOKEN_ROTATION_ID ?? '').trim()
      const tokenName = isProduction ? 'airingcal-production-writer' : 'airingcal-development-writer'

      let credentialVerification = {
        presence: hasGhS3Secrets || (overrideId && overrideSecret) ? 'present' : 'absent',
        reuse: 'none',
        scopeVerification: 'unverified',
        runtimeVerification: 'not-verified',
        tokenId: null,
        tokenName: null,
      }
      let writerCredentialState = 'not-provisioned'

      if (!overrideId && !overrideSecret && !rotationId) {
        if (!hasGhS3Secrets) {
          throw taggedError(
            `GitHub Environment "${envName}" is missing ${prefix}S3_ACCESS_KEY_ID or ${prefix}S3_SECRET_ACCESS_KEY, and no S3 override or token rotation was provided. Cannot update without valid Writer credentials.`,
            { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'resource-conflict', exitCode: 2 },
          )
        }
        credentialVerification.reuse = 'reused-existing'
        credentialVerification.runtimeVerification = 'not-verified-github-secret-only'
        writerCredentialState = 'reused-unverified-runtime'

        // Attempt to verify token presence, active status, and bucket-scoped policy via Cloudflare API
        try {
          const listed = await cfApi(fetchImpl, parentToken, '/user/tokens')
          const tokens = Array.isArray(listed?.result) ? listed.result : []
          const expectedTokenId = priorInv?.writerCredential?.tokenId ?? null
          const matchedToken = expectedTokenId
            ? tokens.find((t) => String(t?.id ?? '') === String(expectedTokenId))
            : tokens.find((t) => String(t?.name ?? '') === tokenName && t?.id)
          if (matchedToken) {
            if (String(matchedToken.status ?? 'active') !== 'active') {
              throw taggedError(
                `Existing Writer token "${matchedToken.name}" (${matchedToken.id}) is not active (status: ${matchedToken.status}).`,
                { code: 'WRITER_TOKEN_INACTIVE', errorCategory: 'permission-denied', exitCode: 2 },
              )
            }
            credentialVerification.tokenId = String(matchedToken.id)
            credentialVerification.tokenName = String(matchedToken.name)
            try {
              const details = await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(String(matchedToken.id))}`)
              const policies = Array.isArray(details?.result?.policies) ? details.result.policies : []
              const bucketResource = r2BucketResourceKey(accountId, bucket)
              const bucketScoped = policies.length === 1 && (() => {
                const policy = policies[0]
                const keys = Object.keys(policy?.resources ?? {})
                return policy?.effect === 'allow' && keys.length === 1 && keys[0] === bucketResource
              })()
              if (!bucketScoped) {
                throw taggedError(
                  `Existing Writer token "${matchedToken.name}" (${matchedToken.id}) is not restricted to bucket "${bucket}". Refusing update.`,
                  { code: 'WRITER_SCOPE_VIOLATION', errorCategory: 'scope-violation', exitCode: 2 },
                )
              }
              credentialVerification.scopeVerification = 'verified-bucket-scoped'
              writerCredentialState = 'reused-scope-verified'
            } catch (err) {
              if (err?.code === 'WRITER_SCOPE_VIOLATION') throw err
              credentialVerification.scopeVerification = 'unverified-readback-unavailable'
            }
          } else {
            credentialVerification.scopeVerification = 'unverified-token-not-listed'
          }
        } catch (err) {
          if (err?.code === 'WRITER_SCOPE_VIOLATION' || err?.code === 'WRITER_TOKEN_INACTIVE') throw err
          credentialVerification.scopeVerification = 'unverified-token-list-unavailable'
        }
      }

      // 7. Verify existing Release Pointer / manifest / snapshot state BEFORE mutating Worker or Bucket
      let releaseVerified = false
      let installationState = 'verified-initialized'
      const publicBase = String(remotePublicBaseVar || plan.publicBaseUrl || plan.workerOrigin || '').trim().replace(/\/+$/, '')

      if (overrideId && overrideSecret) {
        const store = createObjectStore({
          endpoint: s3EndpointFor(accountId),
          region: String(env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
          bucket,
          accessKeyId: overrideId,
          secretAccessKey: overrideSecret,
        })
        try {
          const keys = await store.list('')
          if (keys.length === 0) {
            installationState = 'verified-empty-pre-sync'
          } else {
            const ptrObj = await store.get('public/current-release.json')
            const hasCheckpoint = keys.some((k) => k.startsWith('checkpoints/'))
            if (!ptrObj && !hasCheckpoint) {
              throw taggedError(
                `Target bucket "${bucket}" is nonempty (${keys.length} object(s)) but contains neither an AiringCal release pointer nor checkpoints. Refusing update of foreign bucket.`,
                { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
              )
            }
            if (ptrObj) {
              let ptr = null
              try { ptr = JSON.parse(new TextDecoder().decode(ptrObj.body)) } catch { ptr = null }
              if (!ptr || typeof ptr.release_id !== 'string' || typeof ptr.artifact_ref !== 'string') {
                throw taggedError(
                  `Existing public/current-release.json in "${bucket}" is malformed or foreign. Refusing update.`,
                  { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
                )
              }
              const snapKey = String(ptr.artifact_ref).replace(/^\/+/, '')
              const snapHead = await store.head(snapKey)
              if (!snapHead) {
                throw taggedError(
                  `Existing release pointer in "${bucket}" references missing snapshot "${snapKey}". Refusing update.`,
                  { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
                )
              }
              releaseVerified = true
            }
          }
        } catch (error) {
          if (error?.code === 'FOREIGN_OR_INCONSISTENT_INSTALLATION') throw error
          const category = isAccessDenied(error) ? 'permission-denied' : 'transport-failure'
          throw taggedError(
            `Failed to inspect existing objects in "${bucket}": ${redactSecrets(error?.message ?? String(error), secrets)}`,
            { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: category, exitCode: category === 'permission-denied' ? 2 : 1 },
          )
        } finally {
          store.close?.()
        }
      } else if (publicBase && typeof fetchImpl === 'function') {
        // Verify release pointer through the ALREADY-DEPLOYED bound Worker (before deploying any new Worker!)
        let ptrRes
        try {
          ptrRes = await fetchImpl(`${publicBase}/public/current-release.json`, {
            headers: { 'cache-control': 'no-cache' },
            redirect: 'manual',
          })
        } catch (error) {
          throw taggedError(
            `Cannot read release pointer from existing Worker "${publicBase}/public/current-release.json": ${redactSecrets(error?.message ?? String(error), secrets)}`,
            { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'transport-failure', exitCode: 1 },
          )
        }
        if (Number(ptrRes?.status) === 200) {
          let ptr = null
          try { ptr = await ptrRes.json() } catch { ptr = null }
          if (!ptr || typeof ptr.release_id !== 'string' || typeof ptr.artifact_ref !== 'string') {
            throw taggedError(
              `Existing Worker at "${publicBase}" returned a non-AiringCal /public/current-release.json payload. Refusing update.`,
              { code: 'FOREIGN_OR_INCONSISTENT_INSTALLATION', errorCategory: 'resource-conflict', exitCode: 2 },
            )
          }
          releaseVerified = true
          installationState = 'verified-initialized'
        } else if (Number(ptrRes?.status) === 404) {
          // Pointer is 404 on the bound Worker -> allowed ONLY if this is a verified-empty-pre-sync installation
          const priorOwnership = hasAffirmativeBucketOwnership(priorInv, bucket, accountId)
          const envMatches = remoteBucketVar === bucket && (!remoteAcctVar || remoteAcctVar.toLowerCase() === accountId.toLowerCase())
          if (!priorOwnership && !envMatches) {
            throw taggedError(
              `Existing Worker at "${publicBase}" has no published release pointer (HTTP 404) and ownership cannot be proven from consistent GitHub Environment variables or local inventory.`,
              { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'resource-conflict', exitCode: 2 },
            )
          }
          installationState = 'verified-empty-pre-sync'
        } else {
          throw taggedError(
            `Existing Worker at "${publicBase}/public/current-release.json" returned unexpected HTTP ${ptrRes?.status ?? 'error'}; refusing update without verified state.`,
            { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'transport-failure', exitCode: 1 },
          )
        }
      } else {
        throw taggedError(
          'Cannot verify existing installation state: neither S3 credentials nor a readable Worker origin are available.',
          { code: 'OWNERSHIP_EVIDENCE_INSUFFICIENT', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }

      ctx.reusedExistingS3Secrets = credentialVerification.reuse === 'reused-existing'
      return {
        ok: true,
        installationState,
        releaseVerified,
        observedBucket,
        credentialVerification,
        writerCredentialState,
      }
    },
    async probeToken(ctx = {}) {
      const token = tokenFromEnv(env)
      if (!token) {
        return {
          ok: false,
          exitCode: 2,
          code: 'TOKEN_MISSING',
          errorCategory: 'permission-denied',
          missingScopes: [
            'Workers R2 Storage Write',
            'Workers Scripts Write',
            'R2 S3 API token derivation',
          ],
        }
      }

      const missingScopes = []
      const pushTransient = () => {
        if (!missingScopes.includes(TRANSIENT_NETWORK_NOTE)) missingScopes.push(TRANSIENT_NETWORK_NOTE)
      }
      let transientOnly = true
      let wrongAccountError = null

      try {
        const whoami = await runWrangler(
          spawnSyncImpl,
          ['whoami', '--json'],
          { ...env, CLOUDFLARE_API_TOKEN: token },
          { sleep: sleepImpl },
        )
        const accounts = parseWranglerWhoamiAccounts(whoami.stdout)
        const expectedAccountId = accountIdFrom(env, plan)
        if (expectedAccountId) {
          if (!accounts.includes(expectedAccountId)) {
            wrongAccountError = {
              ok: false,
              exitCode: 2,
              code: 'WRONG_ACCOUNT',
              errorCategory: 'resource-conflict',
              reason: `Selected Cloudflare account ${expectedAccountId} is not accessible by this API token (visible: ${accounts.join(', ')})`,
              missingScopes: [],
            }
          } else {
            ctx.accountId = expectedAccountId
          }
        } else if (isProduction && accounts.length > 1) {
          wrongAccountError = {
            ok: false,
            exitCode: 2,
            code: 'WRONG_ACCOUNT',
            errorCategory: 'resource-conflict',
            reason: `Multiple Cloudflare accounts visible (${accounts.join(', ')}); explicit AIRINGCAL_CLOUDFLARE_ACCOUNT_ID is required for Production`,
            missingScopes: [],
          }
        } else {
          ctx.accountId = accounts[0]
          env.AIRINGCAL_CLOUDFLARE_ACCOUNT_ID = accounts[0]
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (isTransientSpawnFailure(error)) {
          pushTransient()
        } else {
          transientOnly = false
          if (/not authenticated|Unauthorized|403|401|login/i.test(msg)) {
            missingScopes.push('Cloudflare API token authentication (wrangler whoami)')
          } else {
            missingScopes.push(`wrangler whoami: ${redactSecrets(msg, secrets)}`)
          }
        }
      }

      if (wrongAccountError) {
        return wrongAccountError
      }

      try {
        await runWrangler(
          spawnSyncImpl,
          ['r2', 'bucket', 'list'],
          { ...env, CLOUDFLARE_API_TOKEN: token },
          { sleep: sleepImpl },
        )
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (isTransientSpawnFailure(error)) {
          pushTransient()
        } else {
          transientOnly = false
          missingScopes.push(
            /403|401|permission|scope|auth/i.test(msg)
              ? 'Workers R2 Storage Write (wrangler r2 bucket list)'
              : `wrangler r2 bucket list: ${redactSecrets(msg, secrets)}`,
          )
        }
      }

      if (missingScopes.length > 0) {
        return {
          ok: false,
          exitCode: transientOnly ? 1 : 2,
          code: transientOnly ? 'CLOUDFLARE_TRANSPORT_FAILURE' : 'TOKEN_MISSING_SCOPES',
          errorCategory: transientOnly ? 'transport-failure' : 'permission-denied',
          missingScopes,
        }
      }
      return { ok: true, missingScopes: [], tokenPresent: true, accountId: ctx.accountId }
    },

    async deriveAndVerifyS3(ctx = {}) {
      const accountId = accountIdFrom(env, plan) || ctx.accountId
      if (!accountId) {
        throw taggedError('AIRINGCAL_CLOUDFLARE_ACCOUNT_ID required to derive/verify S3 credentials', {
          code: 'ACCOUNT_ID_MISSING',
          errorCategory: 'resource-conflict',
          exitCode: 2,
        })
      }
      const endpoint = s3EndpointFor(accountId)
      const overrideId = String(env.AIRINGCAL_S3_ACCESS_KEY_ID ?? '').trim()
      const overrideSecret = String(env.AIRINGCAL_S3_SECRET_ACCESS_KEY ?? '').trim()

      let overrideRejectionNote = null
      if (overrideId && overrideSecret) {
        const creds = {
          accessKeyId: overrideId,
          secretAccessKey: overrideSecret,
          endpoint,
          region: String(env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
          derived: false,
          // #195 correction: an operator-supplied key cannot be scope-proven
          // through the Cloudflare API (its secret is not the API token).
          source: 'operator-override',
          scope: 'operator-supplied-scope-unverified',
        }
        try {
          const verified = await verifyS3Access(creds, bucket, { allowMissingBucket: true })
          ctx.s3BucketNotReady = !verified.bucketReady
          s3Creds = creds
          ctx.s3 = {
            accessKeyId: overrideId,
            derived: false,
            verified: Boolean(verified.bucketReady),
            pendingBucketAccessProof: !verified.bucketReady,
            source: creds.source,
            scope: creds.scope,
          }
          if (verified.bucketReady) {
            process.stderr.write(`[deploy-env] S3 override verified on ${bucket}\n`)
          } else {
            process.stderr.write(
              `[deploy-env] S3 override accepted (bucket ${bucket} does not exist yet; object access will be verified after bucket creation)\n`,
            )
          }
          return {
            accessKeyId: overrideId,
            secretAccessKey: overrideSecret,
            derived: false,
            verified: Boolean(verified.bucketReady),
            pendingBucketAccessProof: !verified.bucketReady,
            source: creds.source,
            scope: creds.scope,
          }
        } catch (error) {
          if (error?.s3Rejected) {
            if (isProduction) {
              throw taggedError(
                `Provided AIRINGCAL_S3_* override credential was rejected for ${bucket}: ${redactSecrets(error.message, secrets)}`,
                {
                  code: 'S3_OVERRIDE_REJECTED',
                  errorCategory: 'permission-denied',
                  missingScopes: error.missingScopes ?? ['Workers R2 Storage Write'],
                  exitCode: 2,
                },
              )
            }
            overrideRejectionNote =
              `AIRINGCAL_S3_* override rejected for ${bucket}; continuing with the dedicated credential path`
            ctx.s3OverrideRejection = overrideRejectionNote
            process.stderr.write(`[deploy-env] ${overrideRejectionNote}\n`)
          } else {
            if (error && typeof error === 'object' && !error.errorCategory) {
              error.errorCategory = isAmbiguousTransportError(error) ? 'transport-failure' : 'provider-incompatibility'
            }
            throw error
          }
        }
      }

      // #195 correction: Production never uses management-token self-derived
      // S3 access as evidence of a bucket-only Writer. Defer the dedicated,
      // bucket-scoped credential to the post-bucket step (which also proves
      // resource ownership) so it can be created and scope-verified there.
      if (isProduction) {
        ctx.writerCredentialDeferred = true
        return {
          deferred: true,
          reason: 'Production Writer credential must be provisioned and scope-verified after bucket creation',
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
            // Account-wide by construction — never presented as bucket-only.
            scope: 'account-wide-derived',
          }
          try {
            await verifyS3Access(creds, bucket, { allowMissingBucket: true })
            s3Creds = creds
            ctx.s3 = {
              accessKeyId: tokenId,
              derived: true,
              source: 'management-token',
              scope: creds.scope,
              verified: true,
            }
            process.stderr.write('[deploy-env] Derived and verified R2 S3 credentials from the management token\n')
            return {
              accessKeyId: tokenId,
              secretAccessKey: creds.secretAccessKey,
              derived: true,
              source: 'management-token',
              scope: creds.scope,
              verified: true,
            }
          } catch (error) {
            // Object-permission (or other) failure with the management token —
            // the dedicated scoped token in step 3 may still work.
            const msg = error instanceof Error ? error.message : String(error)
            if (!isProduction) {
              process.stderr.write(
                `[deploy-env] Management-token S3 derivation not usable (${redactSecrets(msg, secrets)}); trying scoped-token fallback\n`,
              )
            }
          }
        } else if (!isProduction) {
          process.stderr.write(
            '[deploy-env] GET /user/tokens/verify returned no token id; trying scoped-token fallback\n',
          )
        }
      } catch {
        if (!isProduction) {
          process.stderr.write(
            '[deploy-env] Management token could not be verified; trying scoped-token fallback\n',
          )
        }
      }

      // Production returns earlier (deferred credential); this block is
      // Development-only. A scoped-token fallback is still its last resort.

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

      // #195 P2.3: per-environment canonical writer token name. Existing
      // tokens are NEVER deleted on a name match — the secret of a live
      // token cannot be recovered, so silent rotation would orphan the
      // Writer environment mid-run. Rotation requires the operator-confirmed
      // token id (AIRINGCAL_WRITER_TOKEN_ROTATION_ID); otherwise we fail
      // closed with the reuse/override instructions.
      const tokenName =
        isProduction ? 'airingcal-production-writer' : 'airingcal-development-writer'
      const rotationId = String(env.AIRINGCAL_WRITER_TOKEN_ROTATION_ID ?? '').trim()
      let existingSameName = []
      try {
        const listed = await cfApi(fetchImpl, parentToken, '/user/tokens')
        existingSameName = (Array.isArray(listed?.result) ? listed.result : []).filter(
          (t) => String(t?.name ?? '') === tokenName && t?.id,
        )
      } catch {
        // Token listing not permitted for this parent; the POST below is the
        // enforcement point and no deletion can occur without a confirmed id.
      }
      if (existingSameName.length > 0) {
        if (!rotationId) {
          throw new Error(
            `Writer token "${tokenName}" already exists and its secret cannot be read back. ` +
            `Reuse it (keep the GitHub Environment ${isProduction ? 'AIRINGCAL_PRODUCTION' : 'AIRINGCAL_DEVELOPMENT'}_S3_* secrets pointing at it), ` +
            `supply AIRINGCAL_S3_ACCESS_KEY_ID/_SECRET_ACCESS_KEY overrides, or rotate explicitly with ` +
            `AIRINGCAL_WRITER_TOKEN_ROTATION_ID=<that token's id>. Auto delete-and-recreate by name is forbidden (#195).`,
          )
        }
        const target = existingSameName.find((t) => String(t.id) === rotationId)
        if (!target) {
          throw new Error(
            `AIRINGCAL_WRITER_TOKEN_ROTATION_ID "${rotationId}" does not match writer token "${tokenName}" (ids: ${existingSameName.map((t) => t.id).join(', ')})`,
          )
        }
        await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(String(target.id))}`, {
          method: 'DELETE',
        })
        process.stderr.write(`[deploy-env] Rotating confirmed writer token ${tokenName} (${rotationId})\n`)
      }

      let permissionGroupId
      try {
        permissionGroupId = await resolvePermissionGroupId(
          fetchImpl,
          parentToken,
          R2_BUCKET_ITEM_WRITE,
        )
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        throw tokenCreateDeniedError(`bucket-scoped permission group lookup failed: ${detail}`)
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
                // #195 P2.3: scope the Writer credential to exactly the one
                // bucket it may touch, not every bucket in the account.
                resources: { [r2BucketResourceKey(accountId, bucket)]: '*' },
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
        source: 'scoped-token',
        scope: 'bucket-scoped',
        tokenName,
        tokenId: accessKeyId,
      }

      try {
        await verifyS3Access(creds, bucket, { allowMissingBucket: true })
      } catch (error) {
        // The credential we JUST created does not work (unexpected scope,
        // provider regression). Remove it so a retry does not accumulate or
        // leave an orphan token with account-adjacent access. Only the fresh
        // id is ever deleted here — pre-existing tokens stay untouched.
        try {
          await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(accessKeyId)}`, {
            method: 'DELETE',
          })
          process.stderr.write('[deploy-env] Deleted the just-created writer token after failed verification\n')
        } catch {
          // Best effort; the operator-facing error below still refuses the apply.
        }
        if (error?.missingScopes) throw error
        const msg = error instanceof Error ? error.message : String(error)
        const err = new Error(
          `Derived S3 credentials failed list+head on ${bucket}: ${redactSecrets(msg, secrets)}. missing scopes: Workers R2 Storage Write`,
        )
        err.missingScopes = ['Workers R2 Storage Write', 'R2 S3 API token derivation']
        throw err
      }

      s3Creds = creds
      ctx.s3 = {
        accessKeyId,
        derived: true,
        verified: true,
        source: creds.source,
        scope: creds.scope,
      }
      process.stderr.write('[deploy-env] Created and verified scoped R2 S3 credentials (fallback path)\n')
      return {
        accessKeyId,
        secretAccessKey,
        derived: true,
        verified: true,
        source: creds.source,
        scope: creds.scope,
      }
    },


    /**
     * #195 / #208 BUG-003: Production Writer credential is provisioned AFTER
     * the bucket exists and ownership/adoption is proven. Never interprets an
     * absent permission catalogue as verified creation authority, records
     * create/rotate/cleanup mutations at point of execution, and classifies
     * permission, transport, scope, provider, and internal errors separately.
     */
    async provisionProductionWriter(ctx = {}) {
      if (!isProduction) {
        throw taggedError('provisionProductionWriter is Production-only', {
          code: 'INTERNAL_ENV_MISMATCH',
          errorCategory: 'internal-error',
        })
      }
      const accountId = accountIdFrom(env, plan) || ctx.accountId
      if (!accountId) {
        throw taggedError('AIRINGCAL_CLOUDFLARE_ACCOUNT_ID is required for scoped Writer provisioning', {
          code: 'ACCOUNT_ID_MISSING',
          errorCategory: 'resource-conflict',
          exitCode: 2,
        })
      }
      const parentToken = tokenFromEnv(env)
      if (!parentToken) {
        throw taggedError('Cloudflare API token is required for scoped Writer provisioning', {
          code: 'TOKEN_MISSING',
          errorCategory: 'permission-denied',
          exitCode: 2,
        })
      }
      const ledger = ledgerFor(ctx)
      const tokenName = 'airingcal-production-writer'
      const rotationId = String(env.AIRINGCAL_WRITER_TOKEN_ROTATION_ID ?? '').trim()
      const endpoint = s3EndpointFor(accountId)
      const bucketResource = r2BucketResourceKey(accountId, bucket)

      // 1. Advisory permission catalogue probe — undocumented /user/tokens/permissions
      // may return 404 or inconclusive shapes; only an explicit denial aborts here,
      // while documented permission_groups + POST /user/tokens remain authoritative.
      let permissionGroupId
      try {
        const permissionsBody = await cfApi(fetchImpl, parentToken, '/user/tokens/permissions')
        const catalogueVerdict = classifyTokenCreationPermission(permissionsBody)
        ctx.permissionCatalogueStatus = catalogueVerdict
        if (catalogueVerdict === 'denied') {
          throw tokenCreateDeniedError('permission probe shows no edit/create on user API tokens')
        }
      } catch (error) {
        if (error?.missingScopes) throw error
        ctx.permissionCatalogueStatus = 'unavailable'
      }

      try {
        permissionGroupId = await resolvePermissionGroupId(fetchImpl, parentToken, R2_BUCKET_ITEM_WRITE)
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        const category = classifyCfHttpError(error, 'provider-incompatibility')
        if (category === 'permission-denied') {
          throw tokenCreateDeniedError(`permission group lookup: ${detail}`)
        }
        throw taggedError(`Cloudflare R2 permission group lookup failed (${category}): ${detail}`, {
          code: category === 'transport-failure' ? 'PERMISSION_GROUP_TRANSPORT_ERROR' : 'PERMISSION_GROUP_MISSING',
          errorCategory: category,
          exitCode: 1,
        })
      }

      // 2. Collision / explicit rotation — NEVER delete by name alone.
      let existing = []
      try {
        const listed = await cfApi(fetchImpl, parentToken, '/user/tokens')
        existing = (Array.isArray(listed?.result) ? listed.result : []).filter(
          (token) => String(token?.name ?? '') === tokenName && token?.id,
        )
      } catch {
        // Listing may be denied; POST remains authoritative and no token can
        // be deleted without an explicitly confirmed id.
      }
      if (existing.length > 0) {
        const match = rotationId ? existing.find((token) => String(token.id) === rotationId) : null
        if (!match) {
          throw taggedError(
            `Production Writer credential: writer token "${tokenName}" already exists (id ${existing.map((t) => t.id).join(', ')}); ` +
            'supply an independent AIRINGCAL_S3_* credential or rotate the confirmed id with AIRINGCAL_WRITER_TOKEN_ROTATION_ID',
            {
              code: 'WRITER_TOKEN_COLLISION',
              errorCategory: 'resource-conflict',
              missingScopes: ['Workers R2 Storage Write', 'User API Tokens:Edit'],
              exitCode: 2,
            },
          )
        }
        const rotateEntry = ledger.begin({
          op: 'writer-token-rotate-delete',
          stepId: 'provision-writer-credential',
          resourceType: 'cf-api-token',
          target: String(match.id),
        })
        try {
          await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(String(match.id))}`, { method: 'DELETE' })
          rotateEntry.confirm(`rotated ${tokenName}`)
          process.stderr.write(`[deploy-env] Rotated operator-confirmed Production writer token ${rotationId}\n`)
        } catch (error) {
          if (isAmbiguousTransportError(error)) {
            rotateEntry.unknown(error, `Check whether token ${match.id} was deleted before retrying rotation`)
          } else {
            rotateEntry.fail(error)
          }
          throw taggedError(
            `Failed to rotate confirmed writer token ${match.id}: ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)}`,
            {
              code: 'WRITER_TOKEN_ROTATION_FAILED',
              errorCategory: classifyCfHttpError(error, 'provider-incompatibility'),
              exitCode: 1,
            },
          )
        }
      }

      // 3. Create the bucket-scoped credential via the official API (recorded at point of call).
      const createEntry = ledger.begin({
        op: 'writer-token-create',
        stepId: 'provision-writer-credential',
        resourceType: 'cf-api-token',
        target: tokenName,
      })
      let created
      try {
        created = await cfApi(fetchImpl, parentToken, '/user/tokens', {
          method: 'POST',
          body: JSON.stringify({
            name: tokenName,
            policies: [{
              effect: 'allow',
              resources: { [bucketResource]: '*' },
              permission_groups: [{ id: permissionGroupId }],
            }],
          }),
        }, { attempts: 1 })
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        if (isAmbiguousTransportError(error)) {
          createEntry.unknown(
            error,
            `List Cloudflare API tokens for "${tokenName}" to check whether creation succeeded despite the lost response`,
          )
          throw taggedError(
            `Writer token creation had an ambiguous transport failure (${detail}); remote creation state is unknown`,
            {
              code: 'WRITER_TOKEN_CREATE_AMBIGUOUS',
              errorCategory: 'transport-failure',
              exitCode: 1,
            },
          )
        }
        createEntry.fail(error)
        const category = classifyCfHttpError(error, 'provider-incompatibility')
        if (category === 'permission-denied') {
          throw tokenCreateDeniedError(`POST /user/tokens: ${detail}`)
        }
        throw taggedError(`Cloudflare Create Token API failed (${category}): ${detail}`, {
          code: 'WRITER_TOKEN_CREATE_FAILED',
          errorCategory: category,
          exitCode: 1,
        })
      }

      const tokenId = String(created?.result?.id ?? '').trim()
      const tokenValue = String(created?.result?.value ?? '').trim()

      const cleanupTokenById = async (idToDelete, cleanupCtx = ctx) => {
        const cleanupEntry = ledgerFor(cleanupCtx).begin({
          op: 'writer-token-cleanup',
          stepId: 'provision-writer-credential',
          resourceType: 'cf-api-token',
          target: idToDelete,
          compensation: true,
        })
        try {
          await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(idToDelete)}`, { method: 'DELETE' })
          cleanupEntry.confirm('deleted unverified writer token')
          return { cleaned: true, error: null }
        } catch (cleanupErr) {
          cleanupEntry.compensationFailed(
            cleanupErr,
            `Manually inspect and delete Cloudflare API token ${idToDelete} (${tokenName}) before retrying`,
          )
          return { cleaned: false, error: cleanupErr }
        }
      }

      if (tokenValue && !secrets.includes(tokenValue)) secrets.push(tokenValue)
      if (!tokenId) {
        createEntry.unknown(
          new Error(
            tokenValue
              ? 'Create Token API response missing token id'
              : 'Create Token API response missing id and value',
          ),
          `List Cloudflare API tokens for "${tokenName}" to check whether creation succeeded despite incomplete response`,
        )
        throw taggedError(
          tokenValue
            ? 'Production Writer credential: Create Token API response missing id'
            : 'Production Writer credential: Create Token API response missing id+value',
          {
            code: 'WRITER_TOKEN_BAD_RESPONSE',
            errorCategory: 'provider-incompatibility',
            exitCode: 1,
          },
        )
      }
      if (!tokenValue) {
        createEntry.confirm(`tokenId=${tokenId} (missing token value)`)
        const cleanup = await cleanupTokenById(tokenId)
        throw taggedError(
          `Production Writer credential: Create Token API returned id ${tokenId} without secret value; ` +
          (cleanup.cleaned
            ? 'the incomplete token was deleted'
            : `token cleanup FAILED (${redactSecrets(cleanup.error?.message ?? 'unknown', secrets)}) — manual deletion required`),
          {
            code: 'WRITER_TOKEN_BAD_RESPONSE',
            errorCategory: 'provider-incompatibility',
            exitCode: 1,
            cleanupFailed: !cleanup.cleaned,
          },
        )
      }
      // Record confirmed creation IMMEDIATELY before verification steps.
      createEntry.confirm(`tokenId=${tokenId}`)

      const creds = {
        accessKeyId: tokenId,
        secretAccessKey: sha256Hex(tokenValue),
        endpoint,
        region: 'auto',
        derived: true,
        source: 'scoped-token',
        scope: 'bucket-scoped',
        tokenName,
        tokenId,
      }

      const cleanupFresh = () => cleanupTokenById(tokenId)

      try {
        // 4. Identity proof: the freshly minted token must verify to its own id.
        let identity
        try {
          identity = await cfApi(fetchImpl, tokenValue, '/user/tokens/verify')
        } catch (error) {
          const category = classifyCfHttpError(error, 'provider-incompatibility')
          throw taggedError(
            `created token identity check failed: ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)}`,
            { code: 'WRITER_IDENTITY_FAILED', errorCategory: category, exitCode: 1 },
          )
        }
        if (String(identity?.result?.id ?? '') !== tokenId || String(identity?.result?.status ?? '') !== 'active') {
          throw taggedError('created token identity verification mismatch', {
            code: 'WRITER_IDENTITY_MISMATCH',
            errorCategory: 'provider-incompatibility',
            exitCode: 1,
          })
        }

        // 5. Scope proof: read the actual policy back with the parent token.
        let details
        try {
          details = await cfApi(fetchImpl, parentToken, `/user/tokens/${encodeURIComponent(tokenId)}`)
        } catch (error) {
          const category = classifyCfHttpError(error, 'transport-failure')
          throw taggedError(
            `created token policy readback failed (${category}): ${redactSecrets(error instanceof Error ? error.message : String(error), secrets)}`,
            { code: 'WRITER_READBACK_FAILED', errorCategory: category, exitCode: 1 },
          )
        }
        const policies = Array.isArray(details?.result?.policies) ? details.result.policies : []
        const bucketOnly = policies.length === 1 && (() => {
          const policy = policies[0]
          const resources = policy?.resources ?? {}
          const keys = Object.keys(resources)
          const groups = Array.isArray(policy?.permission_groups) ? policy.permission_groups : []
          return policy?.effect === 'allow'
            && groups.length === 1
            && String(groups[0]?.id) === String(permissionGroupId)
            && keys.length === 1
            && keys[0] === bucketResource
        })()
        if (!bucketOnly) {
          throw taggedError('created token policy is not restricted to the intended bucket', {
            code: 'WRITER_SCOPE_VIOLATION',
            errorCategory: 'scope-violation',
            exitCode: 2,
          })
        }

        // 6. Access proof on the intended bucket (not a substitute for 4/5).
        try {
          await verifyS3Access(creds, bucket, { allowMissingBucket: false })
        } catch (error) {
          const category = error?.s3Rejected
            ? 'permission-denied'
            : isAmbiguousTransportError(error)
              ? 'transport-failure'
              : 'provider-incompatibility'
          throw taggedError(
            redactSecrets(error instanceof Error ? error.message : String(error), secrets),
            {
              code: 'WRITER_S3_ACCESS_FAILED',
              errorCategory: category,
              missingScopes: error?.missingScopes,
              exitCode: category === 'permission-denied' ? 2 : 1,
            },
          )
        }
      } catch (error) {
        const cleanup = await cleanupFresh()
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        const cleanupNote = cleanup.cleaned
          ? 'the new token was removed'
          : `token cleanup FAILED (${redactSecrets(cleanup.error?.message ?? 'unknown', secrets)}) — manual token deletion required`
        const wrapped = taggedError(`Production Writer credential verification failed (${detail}); ${cleanupNote}`, {
          code: error?.code ?? 'WRITER_VERIFICATION_FAILED',
          errorCategory: error?.errorCategory ?? 'provider-incompatibility',
          missingScopes: error?.missingScopes,
          exitCode: error?.exitCode ?? 1,
          cleanupFailed: !cleanup.cleaned,
        })
        throw wrapped
      }

      s3Creds = creds
      pendingFreshWriterCleanup = async (cleanupCtx = ctx) => {
        const res = await cleanupTokenById(tokenId, cleanupCtx)
        if (res.cleaned) {
          s3Creds = null
          pendingFreshWriterCleanup = null
        }
        return res
      }
      ctx.s3 = {
        accessKeyId: tokenId,
        derived: true,
        verified: true,
        source: creds.source,
        scope: creds.scope,
      }
      process.stderr.write(`[deploy-env] Provisioned and scope-verified Production Writer credential ${tokenName}\n`)
      return {
        ...creds,
        verified: true,
      }
    },

    async cleanupFreshWriterToken(ctx = {}) {
      if (!pendingFreshWriterCleanup) return { cleaned: false, skipped: true }
      return pendingFreshWriterCleanup(ctx)
    },
    async freezeWriter(ctx = {}) {
      if (isProduction) {
        throw taggedError(
          'production apply must not disable the shared writer workflow; the production writer was never enabled and the schedule stays gated by AIRINGCAL_WRITER_ENABLED',
          { code: 'INTERNAL_ENV_MISMATCH', errorCategory: 'internal-error' },
        )
      }
      const workflow = plan.writerFreeze?.workflow || 'portable-writer.yml'
      const ledger = ledgerFor(ctx)
      const freezeEntry = ledger.begin({
        op: 'workflow-state-change',
        stepId: 'writer-freeze',
        resourceType: 'github-workflow',
        target: `${workflow}:disabled`,
      })
      let alreadyFrozen = false
      try {
        alreadyFrozen = await runGhWorkflowToggle(
          spawnSyncImpl,
          ['workflow', 'disable', workflow, '--repo', repo],
          env,
        )
        if (alreadyFrozen) freezeEntry.alreadyExists('workflow already disabled')
        else freezeEntry.confirm('workflow disabled')
      } catch (error) {
        if (isAmbiguousTransportError(error)) {
          freezeEntry.unknown(error, `Check state of ${workflow} in GitHub Actions`)
        } else {
          freezeEntry.fail(error)
        }
        throw error
      }

      const deadline = nowImpl() + 15 * 60_000
      let inProgress = -1
      while (nowImpl() < deadline) {
        const listed = await runGh(
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
        alreadyFrozen,
        leaseClear: true,
        note: 'Lease clear assumed after in_progress=0; staging dispatch blocked via workflow disable',
      }
    },

    async ensureBucket(ctx = {}) {
      const accountId = accountIdFrom(env, plan) || ctx.accountId
      if (plan.accountId && accountId && String(plan.accountId).toLowerCase() !== String(accountId).toLowerCase()) {
        throw taggedError(
          `Wrong-account safety refusal: plan expects ${plan.accountId}, active context resolved ${accountId}`,
          { code: 'WRONG_ACCOUNT', errorCategory: 'resource-conflict', exitCode: 2 },
        )
      }
      const ledger = ledgerFor(ctx)
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
            CLOUDFLARE_ACCOUNT_ID: accountId,
          },
        },
      )
      const infoOut = redactSecrets(`${info.stderr || ''}\n${info.stdout || ''}`.trim(), secrets)
      if (info.error || TRANSIENT_NETWORK_RE.test(infoOut)) {
        throw taggedError(
          `Failed to inspect R2 bucket "${bucket}": ${info.error?.message ?? infoOut}`,
          { code: 'BUCKET_INFO_TRANSPORT_ERROR', errorCategory: 'transport-failure', exitCode: 1 },
        )
      }
      if (
        info.status !== 0 &&
        /401|403|Authentication error|Unauthorized|not authenticated|permission denied|account.*not accessible/i.test(infoOut)
      ) {
        throw taggedError(
          `Permission denied inspecting R2 bucket "${bucket}": ${infoOut}`,
          { code: 'BUCKET_INFO_DENIED', errorCategory: 'permission-denied', exitCode: 2 },
        )
      }

      if (info.status === 0) {
        let infoMeta = null
        try { infoMeta = JSON.parse(String(info.stdout ?? '').trim()) } catch { /* non-JSON info output */ }
        const observedBucket = {
          name: bucket,
          accountId: accountId || null,
          exists: true,
          created: false,
          creationDate: infoMeta?.creation_date ?? infoMeta?.creationDate ?? null,
          location: infoMeta?.location ?? null,
        }
        ctx.observedBucket = observedBucket
        if (isProduction) {
          const isUpdate = (ctx?.operation ?? plan?.operation) === 'update'
          const explicitAdoption =
            isUpdate ||
            Boolean(ctx?.bucketAdoptionAuthorized) ||
            String(env.AIRINGCAL_ADOPT_EXISTING_BUCKET ?? '').trim() === 'yes'
          const inventoryMatch = hasAffirmativeBucketOwnership(ctx?.priorInventory, bucket, accountId)
          if (!explicitAdoption && !inventoryMatch) {
            throw taggedError(
              `Target Production bucket "${bucket}" already exists in account ${accountId || '<unknown>'}, ` +
              'but AiringCal ownership cannot be safely proven (no matching local inventory receipt and no explicit Owner adoption authorization). ' +
              'Refusing to adopt an unverified existing bucket.',
              {
                code: 'BUCKET_OWNERSHIP_UNPROVEN',
                errorCategory: 'resource-conflict',
                exitCode: 2,
              },
            )
          }
          const reuseEntry = ledger.begin({
            op: 'r2-bucket-create',
            stepId: 'ensure-bucket',
            resourceType: 'r2-bucket',
            target: bucket,
          })
          const proofKind = isUpdate
            ? 'verified-existing-installation'
            : (explicitAdoption ? 'explicit-owner-adoption' : 'prior-inventory-match')
          reuseEntry.alreadyExists(`reused existing bucket (${proofKind})`)
          return {
            bucket,
            created: false,
            reused: true,
            accountId,
            ownershipProof: proofKind,
            observedBucket,
            emptyVerified: false,
          }
        }
        const devReuseEntry = ledger.begin({
          op: 'r2-bucket-create',
          stepId: 'ensure-bucket',
          resourceType: 'r2-bucket',
          target: bucket,
        })
        devReuseEntry.alreadyExists('reused existing development bucket')
        return { bucket, created: false, reused: true, accountId, observedBucket, emptyVerified: false }
      }

      const createEntry = ledger.begin({
        op: 'r2-bucket-create',
        stepId: 'ensure-bucket',
        resourceType: 'r2-bucket',
        target: bucket,
      })
      try {
        await runWrangler(
          spawnSyncImpl,
          ['r2', 'bucket', 'create', bucket],
          { ...env, AIRINGCAL_CLOUDFLARE_ACCOUNT_ID: accountId },
          { attempts: 1 },
        )
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        if (isAmbiguousTransportError(error)) {
          createEntry.unknown(
            error,
            `Inspect Cloudflare R2 buckets (wrangler r2 bucket info ${bucket}) or run Reconcile Existing Resources to check whether the bucket was created before retrying`,
          )
          throw taggedError(
            `R2 bucket creation had an ambiguous transport outcome (${detail}); remote state is unknown`,
            { code: 'BUCKET_CREATE_AMBIGUOUS', errorCategory: 'transport-failure', exitCode: 1 },
          )
        }
        createEntry.fail(error)
        const category = /401|403|permission|denied|unauthorized/i.test(detail)
          ? 'permission-denied'
          : 'provider-incompatibility'
        throw taggedError(`Failed to create R2 bucket "${bucket}": ${detail}`, {
          code: 'BUCKET_CREATE_FAILED',
          errorCategory: category,
          exitCode: category === 'permission-denied' ? 2 : 1,
        })
      }
      createEntry.confirm(`created bucket ${bucket} in account ${accountId || '<unknown>'}`)
      const observedBucket = {
        name: bucket,
        accountId: accountId || null,
        exists: true,
        created: true,
        creationDate: null,
        location: null,
      }
      ctx.observedBucket = observedBucket
      return { bucket, created: true, reused: false, accountId, observedBucket, emptyVerified: false }
    },

    async verifyBucketEmpty(ctx = {}) {
      if (!isProduction) {
        return { bucket, emptyVerified: false, skipped: true }
      }
      const ledger = ledgerFor(ctx)
      // Clean bootstrap (production plan requireEmptyBucket): the first Full Sync
      // must find an empty bucket. Reusing a bucket with foreign objects would
      // silently mix foreign data into the release lineage, so refuse closed.
      // One residue class is provably OURS: an interrupted apply between probe
      // write and probe delete. If (and only if) the bucket holds exactly the
      // isolation probe key AND the body matches the known probe body, delete it
      // and verify emptiness again — never weakening the clean-bootstrap guard.
      const store = objectStoreFor(bucket)
      let keys = []
      let probeResidueCleaned = false
      try {
        keys = await store.list('')
        if (keys.length === 1 && keys[0] === probeKey) {
          const object = await store.get(probeKey)
          const body = new TextDecoder().decode(object?.body ?? new Uint8Array())
          if (body === probeBody) {
            const cleanupEntry = ledger.begin({
              op: 'probe-residue-delete',
              stepId: 'verify-bucket-empty',
              resourceType: 'r2-object',
              target: `${bucket}/${probeKey}`,
              compensation: true,
            })
            try {
              await store.delete(probeKey)
              const after = await store.list('')
              if (after.length !== 0) {
                const err = new Error(
                  `probe residue cleanup did not empty ${bucket}: ${after.length} object(s) remain`,
                )
                cleanupEntry.compensationFailed(err, `Inspect objects in ${bucket} before retrying`)
                err.code = 'BUCKET_NOT_EMPTY'
                err.errorCategory = 'resource-conflict'
                err.cleanupFailed = true
                err.exitCode = 1
                throw err
              }
              cleanupEntry.confirm('deleted leftover isolation probe and verified bucket empty')
              probeResidueCleaned = true
              keys = after
            } catch (cleanupErr) {
              if (!cleanupErr.cleanupFailed) {
                cleanupEntry.compensationFailed(cleanupErr, `Delete leftover ${probeKey} or inspect ${bucket}`)
                cleanupErr.cleanupFailed = true
              }
              throw cleanupErr
            }
          }
        }
      } catch (error) {
        if (error?.errorCategory) throw error
        const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets)
        const category = isAccessDenied(error)
          ? 'permission-denied'
          : isAmbiguousTransportError(error)
            ? 'transport-failure'
            : 'provider-incompatibility'
        throw taggedError(`Empty-bucket S3 check failed on ${bucket}: ${detail}`, {
          code: 'BUCKET_EMPTY_CHECK_FAILED',
          errorCategory: category,
          exitCode: category === 'permission-denied' ? 2 : 1,
        })
      } finally {
        store.close?.()
      }
      if (keys.length > 0) {
        throw taggedError(
          `production bootstrap requires an empty bucket: ${bucket} already holds at least ${keys.length} object(s); refusing a dirty bucket`,
          {
            code: 'BUCKET_NOT_EMPTY',
            errorCategory: 'resource-conflict',
            exitCode: 1,
          },
        )
      }
      return { bucket, emptyVerified: true, probeResidueCleaned }
    },

    async disableR2Dev(ctx = {}) {
      const ledger = ledgerFor(ctx)
      const entry = ledger.begin({
        op: 'r2-dev-disable',
        stepId: 'disable-r2-dev',
        resourceType: 'r2-public-access',
        target: bucket,
      })
      try {
        await runWrangler(spawnSyncImpl, ['r2', 'bucket', 'dev-url', 'disable', bucket, '-y'], env)
        const got = await runWrangler(spawnSyncImpl, ['r2', 'bucket', 'dev-url', 'get', bucket], env)
        assertCheckpointBucketPrivate(got.stdout, bucket)
        entry.confirm('r2.dev disabled and verified')
      } catch (error) {
        if (isAmbiguousTransportError(error)) {
          entry.unknown(error, `Check r2.dev status for ${bucket} (wrangler r2 bucket dev-url get ${bucket})`)
        } else {
          entry.fail(error)
        }
        throw error
      }
      return { disabled: true, bucket }
    },

    async attachCustomDomain(ctx = {}) {
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

      const ledger = ledgerFor(ctx)
      const listed = await runWrangler(spawnSyncImpl, ['r2', 'bucket', 'domain', 'list', bucket], env)
      if (listed.stdout && listed.stdout.includes(domain)) {
        ledger.begin({
          op: 'r2-custom-domain-attach',
          stepId: 'attach-custom-domain',
          resourceType: 'r2-custom-domain',
          target: domain,
        }).alreadyExists(`already attached to ${bucket}`)
        return { attached: true, domain, reused: true }
      }

      const entry = ledger.begin({
        op: 'r2-custom-domain-attach',
        stepId: 'attach-custom-domain',
        resourceType: 'r2-custom-domain',
        target: domain,
      })
      try {
        await runWrangler(
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
        entry.confirm(`attached to ${bucket}`)
      } catch (error) {
        if (isAmbiguousTransportError(error)) entry.unknown(error, `Check custom domain ${domain} on ${bucket}`)
        else entry.fail(error)
        throw error
      }
      return { attached: true, domain, reused: false }
    },

    async applyCacheRules(ctx = {}) {
      const zoneId = zoneIdFrom(env)
      const token = tokenFromEnv(env)
      if (!zoneId) {
        throw missingCapability(
          'cache-rules',
          'missing AIRINGCAL_ZONE_ID (or equivalent) for custom domain/WAF/cache rules',
        )
      }
      if (!token) throw new Error('Cloudflare API token required for cache rules')
      const host = publicHostForRules(plan)
      const entry = ledgerFor(ctx).begin({
        op: 'zone-cache-rules',
        stepId: 'cache-rules',
        resourceType: 'cf-zone-ruleset',
        target: `${zoneId}:${host}`,
      })

      try {
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
        if (immutable?.reused && pointer?.reused) entry.alreadyExists('zone cache rules unchanged')
        else entry.confirm('configured host-scoped cache rules')
        return { ok: true, zoneId, host, immutable, pointer }
      } catch (error) {
        if (isAmbiguousTransportError(error)) entry.unknown(error, `Inspect cache rules on zone ${zoneId}`)
        else entry.fail(error)
        if (isZoneScopeError(error)) {
          throw missingCapability('cache-rules', ZONE_SCOPE_CAPABILITY_MESSAGE)
        }
        throw error
      }
    },

    async applyCors(ctx = {}) {
      const origins = plan.cors?.allowedOrigins ?? []
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

      const corsConfig = {
        rules: [
          {
            allowed: {
              origins,
              methods,
            },
            exposeHeaders: ['ETag', 'Content-Type', 'Content-Length'],
            maxAgeSeconds: 86400,
          },
        ],
      }
      const ledger = ledgerFor(ctx)
      const corsEntry = ledger.begin({
        op: 'r2-cors-set',
        stepId: 'cors',
        resourceType: 'r2-cors',
        target: bucket,
      })
      const dir = mkdtempSync(join(tmpdir(), 'airingcal-cors-'))
      const file = join(dir, 'cors.json')
      try {
        writeFileSync(file, `${JSON.stringify(corsConfig, null, 2)}\n`, 'utf8')
        await runWrangler(
          spawnSyncImpl,
          ['r2', 'bucket', 'cors', 'set', bucket, '--file', file, '-y'],
          env,
        )
        corsEntry.confirm('applied exact-origin R2 CORS policy')
      } catch (error) {
        if (isAmbiguousTransportError(error)) corsEntry.unknown(error, `Verify R2 CORS rules on ${bucket}`)
        else corsEntry.fail(error)
        throw error
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      return { ok: true, allowedOrigins: origins, methods, corsFileWritten: true }
    },

    async configureWaf(ctx = {}) {
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
      const entry = ledgerFor(ctx).begin({
        op: 'zone-waf-rule',
        stepId: 'waf-checkpoints',
        resourceType: 'cf-zone-ruleset',
        target: `${zoneId}:${host}`,
      })

      try {
        const rule = await ensureZonePhaseRule({
          fetchImpl,
          token,
          zoneId,
          phase: 'http_request_firewall_custom',
          description: 'airingcal-deny-checkpoints',
          expression: `(http.host eq "${host}" and starts_with(http.request.uri.path, "/checkpoints/"))`,
          action: 'block',
        })
        if (rule?.reused) entry.alreadyExists('WAF checkpoint rule unchanged')
        else entry.confirm('configured host-scoped WAF checkpoint deny rule')
        return { ok: true, zoneId, host, rule }
      } catch (error) {
        if (isAmbiguousTransportError(error)) entry.unknown(error, `Inspect WAF rules on zone ${zoneId}`)
        else entry.fail(error)
        if (isZoneScopeError(error)) {
          throw missingCapability('waf-checkpoints', ZONE_SCOPE_CAPABILITY_MESSAGE)
        }
        throw error
      }
    },

    async writeIsolationProbe(ctx = {}) {
      const ledger = ledgerFor(ctx)
      const store = objectStoreFor(bucket)
      const entry = ledger.begin({
        op: 'isolation-probe-write',
        stepId: 'isolation-probe-write',
        resourceType: 'r2-object',
        target: `${bucket}/${probeKey}`,
      })
      try {
        try {
          await store.put(probeKey, new TextEncoder().encode(probeBody), {
            contentType: 'text/plain; charset=utf-8',
          })
          ctx.isolationProbeWritten = true
          entry.confirm('isolation probe written')
        } catch (error) {
          if (isAmbiguousTransportError(error)) {
            ctx.isolationProbeWritten = true
            entry.unknown(error, `Check whether ${probeKey} was written in ${bucket}`)
          } else {
            entry.fail(error)
          }
          throw error
        }
        // Positive proof (§6.3 / mission 4.1): an anonymous 404 only means
        // isolation if the object demonstrably EXISTS in the private bucket.
        const head = await store.head(probeKey)
        if (!head) {
          throw new Error(`isolation probe written but S3 HEAD ${probeKey} returned no object`)
        }
        return { key: probeKey, body: probeBody, exists: true, size: head.size, etag: head.etag }
      } finally {
        store.close?.()
      }
    },

    /**
     * Anonymous deny evidence against every public entrypoint of THIS plan:
     * - bucket-domain mode: the bucket custom domain (WAF 403 expected);
     * - worker mode (§6.3): each deployed reader origin (CF Worker and, when
     *   deployed, EdgeOne) — the allowlisted public object interface must 404
     *   `checkpoints/**` including encoded/traversal variants.
     * Policy denial or HTTP 400 on the malformed traversal variant is
     * evaluated by the runner. Thrown network errors retry, then fail.
     */
    async probeAnonymousAccess(ctx = {}) {
      if (typeof fetchImpl !== 'function') {
        throw new Error('fetchImpl required for isolation anonymous GET/HEAD probes')
      }
      const origins = []
      if (plan.publicOriginMode === 'worker') {
        const workerUrl = String(ctx?.cloudflareDeploy?.workerUrl ?? '').trim()
        if (workerUrl) origins.push(workerUrl.replace(/\/+$/, ''))
        const edgeoneUrl =
          String(ctx?.edgeoneDeploy?.readerUrl ?? '').trim() ||
          String(env.AIRINGCAL_EDGEONE_READER_URL ?? '').trim()
        if (edgeoneUrl && (plan.target === 'edgeone' || plan.target === 'both')) {
          origins.push(edgeoneUrl.replace(/\/+$/, ''))
        }
        if (origins.length === 0) {
          throw new Error(
            'worker-mode isolation probe requires at least one deployed reader origin (no workerUrl in deploy receipt)',
          )
        }
      } else {
        origins.push(String(plan.publicBaseUrl).replace(/\/+$/, ''))
      }
      const paths = [
        `/${probeKey}`,
        `/${probeKey.replace('checkpoints/', '%63heckpoints/')}`,
        `/public/..%2f..%2f${probeKey}`,
      ]
      const probes = []
      for (const origin of origins) {
        for (const path of paths) {
          const url = `${origin}${path}`
          for (const method of ['GET', 'HEAD']) {
            // Retriable = thrown network error only; any HTTP status is a
            // definitive answer (403/404 is the wanted evidence) and is never retried.
            const response = await withNetworkRetry(
              () => fetchImpl(url, { method, redirect: 'manual' }),
              { isRetriable: isThrownNetworkError, sleep: sleepImpl },
            )
            probes.push({ url, method, status: Number(response.status) })
          }
        }
      }
      return { r2DevDisabled: Boolean(ctx?.r2DevDisabled), probes, origins }
    },

    /**
     * Probe cleanup: the bootstrap isolation probe must never survive into
     * the release bucket — it would (a) violate the clean empty-bucket
     * invariant on retry and (b) leave a foreign-looking object. Verified
     * gone via HEAD before the receipt is issued.
     */
    async deleteIsolationProbe(ctx = {}) {
      const ledger = ledgerFor(ctx)
      const store = objectStoreFor(bucket)
      const entry = ledger.begin({
        op: 'isolation-probe-delete',
        stepId: 'isolation-probe-cleanup',
        resourceType: 'r2-object',
        target: `${bucket}/${probeKey}`,
        compensation: true,
      })
      try {
        await store.delete(probeKey)
        const head = await store.head(probeKey)
        if (head) {
          const err = new Error(`isolation probe delete not visible: S3 HEAD ${probeKey} still returns an object`)
          entry.compensationFailed(err, `Delete leftover ${probeKey} in ${bucket}`)
          throw err
        }
        entry.confirm('isolation probe deleted and HEAD confirmed absent')
        return { key: probeKey, deleted: true }
      } catch (error) {
        if (entry.entry.status === 'attempted') {
          entry.compensationFailed(error, `Verify and delete ${probeKey} in ${bucket}`)
        }
        throw error
      } finally {
        store.close?.()
      }
    },

    async copyPublicPrefixes(ctx = {}) {
      if (isProduction) {
        throw new Error('production apply is copy-free; refusing any staging/development prefix copy')
      }
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
      if (isProduction) {
        throw new Error('production apply is copy-free; refusing any staging checkpoint copy')
      }
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
      const envName = isProduction ? 'production' : 'development'
      // ShipReview #4: the production job's "Validate required production
      // config" treats AIRINGCAL_PRODUCTION_USERS_JSON and _PRIMARY_USER_ID
      // as required vars. The empty-value filter in the write loop below
      // would silently SKIP them, and the FIRST FULL SYNC — the very next
      // Owner action — would fail hours later. Refuse before ANY gh call.
      if (isProduction) {
        const requiredMissing = ['AIRINGCAL_USERS_JSON', 'AIRINGCAL_PRIMARY_USER_ID']
          .filter((sourceKey) => !String(env[sourceKey] ?? '').trim())
        if (requiredMissing.length > 0) {
          throw new Error(
            `production env sync refuses: ${requiredMissing.join(', ')} empty — ` +
              'the production job validates the derived AIRINGCAL_PRODUCTION_* variables as required; ' +
              'set the source keys in .env.production and rerun apply (docs/DEPLOYMENT.md "Production apply")',
          )
        }
      }
      const ledger = ledgerFor(ctx)
      const ghEnvEntry = ledger.begin({
        op: 'github-environment-ensure',
        stepId: 'sync-gh-env',
        resourceType: 'github-environment',
        target: `${repo}/${envName}`,
      })
      try {
        await runGh(spawnSyncImpl, ['api', '--method', 'PUT', `repos/${repo}/environments/${envName}`], env)
        ghEnvEntry.confirm(`ensured GitHub environment ${envName}`)
      } catch (error) {
        if (isAmbiguousTransportError(error)) ghEnvEntry.unknown(error, `Check GitHub environment ${envName} in ${repo}`)
        else ghEnvEntry.fail(error)
        throw error
      }

      const accountId = accountIdFrom(env, plan) || ctx.accountId || ''
      const prefix = isProduction ? 'AIRINGCAL_PRODUCTION_' : 'AIRINGCAL_DEVELOPMENT_'
      const variables = {
        [`${prefix}PRIMARY_USER_ID`]: String(env.AIRINGCAL_PRIMARY_USER_ID ?? '').trim(),
        [`${prefix}CLOUDFLARE_ACCOUNT_ID`]: accountId,
        // §6.3: in worker mode the Worker origin IS the public base — the
        // EdgeOne adapter and verifier consume the allowlisted public
        // object interface there; the bucket keeps no anonymous surface.
        [`${prefix}PUBLIC_BASE_URL`]: plan.publicBaseUrl || plan.workerOrigin || '',
        [`${prefix}R2_BUCKET`]: bucket,
        [`${prefix}S3_ENDPOINT`]: s3EndpointFor(accountId),
        [`${prefix}S3_REGION`]: String(env.AIRINGCAL_S3_REGION ?? 'auto').trim() || 'auto',
        [`${prefix}WORKER_NAME`]: plan.cloudflareWorkerName || DEVELOPMENT_DEFAULTS.workerName,
      }
      if (isProduction) {
        // Both production writer gates stay off in apply: the schedule reads
        // the repo-level AIRINGCAL_WRITER_ENABLED (untouched here) and manual
        // dispatches read AIRINGCAL_PRODUCTION_BOOTSTRAP_WRITER_ENABLED.
        variables[`${prefix}BOOTSTRAP_WRITER_ENABLED`] = 'false'
        const explicitReleaseSha = String(env.AIRINGCAL_PRODUCTION_RELEASE_SHA ?? '').trim()
        const rawReleaseRef = String(env.AIRINGCAL_PRODUCTION_RELEASE_REF ?? '').trim()
        const fallbackGitSha = String(env.BANGUMI_GIT_COMMIT_SHA ?? plan.gitSha ?? '').trim() || (() => {
          const r = spawnSyncImpl('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: ROOT })
          const candidate = r?.status === 0 ? String(r.stdout ?? '').trim() : ''
          return /^[0-9a-f]{40}$/i.test(candidate) ? candidate : ''
        })()
        const releaseShaCandidate = explicitReleaseSha || fallbackGitSha
        if (explicitReleaseSha || rawReleaseRef) {
          const validated = validateProductionReleaseIdentity({
            releaseSha: releaseShaCandidate,
            releaseRef: rawReleaseRef,
          })
          variables[`${prefix}RELEASE_SHA`] = validated.releaseSha
          if (validated.releaseRef) {
            variables[`${prefix}RELEASE_REF`] = validated.releaseRef
          }
        } else if (/^[0-9a-f]{40}$/i.test(releaseShaCandidate)) {
          variables[`${prefix}RELEASE_SHA`] = releaseShaCandidate.toLowerCase()
        }
      } else {
        variables[`${prefix}WRITER_ENABLED`] = 'false'
      }
      const allowedVariableKeys = isProduction ? PRODUCTION_VARIABLE_KEYS : DEVELOPMENT_VARIABLE_KEYS
      if (env.AIRINGCAL_USERS_JSON) {
        variables[`${prefix}USERS_JSON`] = String(env.AIRINGCAL_USERS_JSON)
      } else if (!isProduction) {
        // The development writer job requires AIRINGCAL_DEVELOPMENT_USERS_JSON.
        // When .env omits it (the normal case), reuse the verified staging
        // Environment value instead of leaving the writer job unconfigured.
        const stagingUsers = await runGh(
          spawnSyncImpl,
          [
            'api',
            `repos/${repo}/environments/staging/variables/AIRINGCAL_STAGING_USERS_JSON`,
            '--jq',
            '.value',
          ],
          env,
        ).catch(() => null)
        const value = String(stagingUsers?.stdout ?? '').trim()
        if (value) variables[`${prefix}USERS_JSON`] = value
      }

      const syncedVars = []
      for (const [name, value] of Object.entries(variables)) {
        if (!allowedVariableKeys.includes(name)) continue
        const writerGateName = isProduction ? `${prefix}BOOTSTRAP_WRITER_ENABLED` : `${prefix}WRITER_ENABLED`
        if (!value && name !== writerGateName) continue
        const varEntry = ledger.begin({
          op: 'github-variable-set',
          stepId: 'sync-gh-env',
          resourceType: 'github-variable',
          target: `${envName}:${name}`,
        })
        try {
          await runGh(
            spawnSyncImpl,
            ['variable', 'set', name, '--env', envName, '--repo', repo, '--body', String(value)],
            env,
          )
          varEntry.confirm(`set variable ${name}`)
          syncedVars.push(name)
        } catch (error) {
          if (isAmbiguousTransportError(error)) varEntry.unknown(error, `Inspect GitHub variable ${name} on ${envName}`)
          else varEntry.fail(error)
          throw error
        }
      }

      const listRes = await runGh(
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

      const s3 = s3Creds
      const reusingExistingGhS3 =
        !s3 &&
        (ctx?.reusedExistingS3Secrets === true || (ctx?.operation ?? plan?.operation) === 'update') &&
        existing.has(`${prefix}S3_ACCESS_KEY_ID`) &&
        existing.has(`${prefix}S3_SECRET_ACCESS_KEY`)
      if (!s3 && !reusingExistingGhS3) {
        requireS3()
      }
      const secretMap = {
        [`${prefix}BANGUMI_TOKEN`]: String(env.AIRINGCAL_BANGUMI_TOKEN ?? '').trim(),
        [`${prefix}S3_ACCESS_KEY_ID`]: s3?.accessKeyId ?? '',
        [`${prefix}S3_SECRET_ACCESS_KEY`]: s3?.secretAccessKey ?? '',
      }
      if (isProduction && String(env.AIRINGCAL_BARK_URL ?? '').trim()) {
        secretMap[`${prefix}BARK_URL`] = String(env.AIRINGCAL_BARK_URL).trim()
      }
      const allowedSecretKeys = isProduction ? PRODUCTION_SECRET_KEYS : DEVELOPMENT_SECRET_KEYS
      const syncedSecrets = []
      const preservedSecrets = []
      const missingSecrets = []
      for (const [name, value] of Object.entries(secretMap)) {
        if (!allowedSecretKeys.includes(name)) continue
        if (value) {
          const secretEntry = ledger.begin({
            op: 'github-secret-set',
            stepId: 'sync-gh-env',
            resourceType: 'github-secret',
            target: `${envName}:${name}`,
          })
          try {
            await runGh(
              spawnSyncImpl,
              ['secret', 'set', name, '--env', envName, '--repo', repo],
              env,
              { input: value },
            )
            secretEntry.confirm(`set secret ${name}`)
            syncedSecrets.push(name)
          } catch (error) {
            if (isAmbiguousTransportError(error)) secretEntry.unknown(error, `Inspect GitHub secret ${name} on ${envName}`)
            else secretEntry.fail(error)
            throw error
          }
        } else if (existing.has(name)) {
          preservedSecrets.push(name)
        } else {
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
        secretsPreserved: preservedSecrets,
        writerEnabled: false,
      }
    },

    async deployCloudflareReader(ctx = {}) {
      const workerName = plan.cloudflareWorkerName || DEVELOPMENT_DEFAULTS.workerName
      const outDir = mkdtempSync(join(tmpdir(), 'airingcal-wrangler-'))
      const outToml = join(outDir, `wrangler-v3-read-${isProduction ? 'production' : 'development'}.toml`)
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

      const ledger = ledgerFor(ctx)
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
              AIRINGCAL_STAGING_PUBLIC_BASE_URL: plan.publicBaseUrl ?? '',
              AIRINGCAL_CORS_ORIGINS:
                plan.publicOriginMode === 'worker' ? (plan.cors?.allowedOrigins ?? []).join(',') : '',
              AIRINGCAL_IMAGE_BASE_URL: String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim(),
              BANGUMI_GIT_COMMIT_SHA: gitSha,
              PACKAGE_VERSION: String(env.PACKAGE_VERSION ?? '').trim(),
            },
          },
        )
        assertSpawnOk(mat, 'materialize-v3-read-staging-config', secrets)

        const deployEntry = ledger.begin({
          op: 'worker-deploy',
          stepId: 'deploy-cloudflare',
          resourceType: 'cloudflare-worker',
          target: workerName,
        })
        let deploy
        try {
          deploy = await runWrangler(
            spawnSyncImpl,
            ['deploy', '--config', outToml, '--name', workerName],
            env,
          )
        } catch (error) {
          if (isAmbiguousTransportError(error)) {
            deployEntry.unknown(error, `Check Cloudflare Workers deployments for "${workerName}"`)
          } else {
            deployEntry.fail(error)
          }
          throw error
        }
        const urlMatch = String(deploy.stdout || '').match(
          /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i,
        )
        deployEntry.confirm(`deployed ${workerName}${urlMatch ? ` (${urlMatch[0]})` : ''}`)
        return {
          deployed: true,
          workerName,
          workerUrl: urlMatch ? urlMatch[0] : null,
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true })
      }
    },

    async deployEdgeoneOverseas(ctx = {}) {
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
      const distEnvFile = join(dist, '.env')
      // EdgeOne Makers injects runtime vars from a `.env` bundled with the
      // deployment; a project-level `env set` alone is NOT visible to the edge
      // function. Link into a fresh temp cwd, mutate env there, pull the full
      // env in that cwd, copy it into the dist bundle, then deploy FROM the
      // linked cwd so the bundle carries the values.
      const linkDir = mkdtempSync(join(tmpdir(), 'airingcal-eo-link-'))
      const linkEnvFile = join(linkDir, '.env')
      const eoSpawn = (args, label) =>
        assertSpawnOk(
          spawnSyncImpl('edgeone', args, {
            encoding: 'utf8',
            cwd: linkDir,
            env: { ...process.env, ...env },
          }),
          label,
          secrets,
        )

      try {
        // `link` writes a `.env` in the linked cwd from the project's current
        // vars; all subsequent Makers commands run from this cwd.
        eoSpawn(
          ['makers', 'link', '-n', project, '-a', region, '-t', token],
          `edgeone makers link -n ${project}`,
        )

        const envPairs = [
          // §6.3: private bucket → EdgeOne's HttpPublicStore consumes the
          // Worker's controlled public object interface, not the bucket.
          ['AIRINGCAL_PUBLIC_BASE_URL', plan.publicBaseUrl || plan.workerOrigin],
          ['NSFW_SHOW', String(env.AIRINGCAL_NSFW_SHOW ?? 'false')],
        ]
        if (env.PACKAGE_VERSION) {
          envPairs.push(['PACKAGE_VERSION', String(env.PACKAGE_VERSION)])
        }
        // Image CDN default off means an explicitly cleared EdgeOne project
        // variable: EdgeOne project env persists across deploys, so a
        // previously configured base would stay sticky (and a later
        // verifyImageRouting would abort against the stale CDN origin).
        // Unset/empty therefore runs `env rm`; non-empty is propagated.
        const edgeoneImageBaseUrl = String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim()
        if (edgeoneImageBaseUrl) {
          envPairs.push(['AIRINGCAL_IMAGE_BASE_URL', edgeoneImageBaseUrl])
        }
        for (const [key, value] of envPairs) {
          eoSpawn(
            ['makers', 'env', 'set', key, value, '-e', 'production', '-t', token],
            `edgeone makers env set ${key}`,
          )
        }

        let imageBaseUrlCleared = false
        if (!edgeoneImageBaseUrl) {
          assertEdgeoneEnvRmOk(
            spawnSyncImpl(
              'edgeone',
              ['makers', 'env', 'rm', 'AIRINGCAL_IMAGE_BASE_URL', '-e', 'production', '-t', token],
              { encoding: 'utf8', cwd: linkDir, env: { ...process.env, ...env } },
            ),
            'edgeone makers env rm AIRINGCAL_IMAGE_BASE_URL',
            secrets,
          )
          imageBaseUrlCleared = true
        }

        // `-f .env` is relative to the linked cwd; the CLI does not write to
        // arbitrary absolute paths (verified live). Pull there, validate, then
        // copy into dist/.env for the deployment bundle.
        eoSpawn(
          ['makers', 'env', 'pull', '-e', 'production', '-t', token, '-f', '.env'],
          'edgeone makers env pull',
        )
        if (!existsSync(linkEnvFile)) {
          throw new Error(
            `edgeone makers env pull did not produce ${linkEnvFile}; refusing to deploy without bundled runtime env`,
          )
        }
        const envContent = readFileSync(linkEnvFile, 'utf8')
        const pulled = parseEdgeoneEnvFile(envContent)
        for (const [key, value] of envPairs) {
          if (pulled[key] !== value) {
            throw new Error(
              `edgeone env pull ${linkEnvFile} is missing ${key}=${value} (got ${pulled[key] ?? '<absent>'}); refusing to deploy without bundled runtime env`,
            )
          }
        }
        if (!edgeoneImageBaseUrl && Object.prototype.hasOwnProperty.call(pulled, 'AIRINGCAL_IMAGE_BASE_URL')) {
          throw new Error(
            `edgeone env pull ${linkEnvFile} still contains a sticky AIRINGCAL_IMAGE_BASE_URL after env rm; refusing to deploy`,
          )
        }
        mkdirSync(dirname(distEnvFile), { recursive: true })
        writeFileSync(distEnvFile, envContent)

        const deployEntry = ledgerFor(ctx).begin({
          op: 'edgeone-deploy',
          stepId: 'deploy-edgeone',
          resourceType: 'edgeone-project',
          target: project,
        })
        let deploy
        try {
          deploy = eoSpawn(
            ['makers', 'deploy', dist, '-n', project, '-a', region, '-t', token, '-e', 'production', '--json'],
            `edgeone makers deploy -n ${project}`,
          )
          deployEntry.confirm(`deployed EdgeOne project ${project}`)
        } catch (error) {
          if (isAmbiguousTransportError(error)) deployEntry.unknown(error, `Check EdgeOne deployment status for ${project}`)
          else deployEntry.fail(error)
          throw error
        }

        return {
          deployed: true,
          project,
          region,
          createdViaDeploy: true,
          readerUrl: parseEdgeoneDeployUrl(deploy.stdout),
          imageBaseUrl: edgeoneImageBaseUrl || null,
          imageBaseUrlPersisted: Boolean(edgeoneImageBaseUrl),
          imageBaseUrlCleared,
        }
      } finally {
        rmSync(distEnvFile, { force: true })
        rmSync(linkDir, { recursive: true, force: true })
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
      const publicBase = (
        String(plan.publicBaseUrl ?? '').trim() || String(ctx.cloudflareDeploy?.workerUrl ?? '').trim()
      ).replace(/\/+$/, '')
      if (!publicBase) {
        throw new Error(
          'image routing verification failed: no public data base (bucket-domain mode requires plan.publicBaseUrl; worker mode requires the deployed Worker URL)',
        )
      }
      const imageBase = String(env.AIRINGCAL_IMAGE_BASE_URL ?? '').trim()
      const expectedOrigin = new URL(imageBase || publicBase).origin

      // Version-propagation race (same class as the image probes, first seen
      // in the 2026-11-26 wizard dev apply): right after `wrangler deploy`
      // in worker mode the workers.dev route can still return 404 for
      // object paths. Retry the pointer/snapshot reads with bounded backoff
      // before failing closed; redirect (bucket-domain) mode stays
      // single-shot.
      const fetchWithPropagationRetry = async (url) => {
        const attempts = plan.publicOriginMode === 'worker' ? 6 : 1
        let response
        for (let attempt = 1; ; attempt += 1) {
          response = await withNetworkRetry(
            () =>
              fetchImpl(url, {
                headers: { 'cache-control': 'no-cache' },
                redirect: 'manual',
              }),
            { isRetriable: isThrownNetworkError, sleep: sleepImpl },
          )
          if (isOkResponse(response) || attempt >= attempts) return response
          await sleepImpl(400 * attempt)
        }
      }
      // Discovery first: a release with zero image hashes is skipped before
      // any reader-host gating, so a missing EdgeOne host must never mask the
      // legitimate `skipped-no-images` outcome.
      const pointerUrl = `${publicBase}/public/current-release.json`
      const pointerResponse = await fetchWithPropagationRetry(pointerUrl)
      if (!isOkResponse(pointerResponse)) {
        // Clean bootstrap (#73): on a copy-free production plan the pointer
        // CANNOT exist yet — the first Full Sync is an Owner dispatch that
        // runs after this apply. Record an explicit skip instead of aborting
        // (the bucket/readers were already mutated by prior steps). Every
        // other mode keeps failing closed on a non-2xx pointer.
        if (plan.copyFree === true && Number(pointerResponse?.status ?? 0) === 404) {
          return {
            status: 'skipped-no-release',
            reason: `no published release yet on ${publicBase} (pointer 404); image routing verifies after the first Full Sync`,
          }
        }
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
      const snapshotResponse = await fetchWithPropagationRetry(snapshotUrl)
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

      const receipts = []
      for (const reader of readers) {
        const imageUrl = `${reader.base}/image/${hash}`
        // Version-propagation race (D1 live apply 2026-11-25): the first
        // requests after `wrangler deploy` can still land on the previous
        // version, which 302s to the legacy bucket domain. In worker mode
        // that is a KNOWN transient (the new build streams); retry with
        // bounded backoff before failing closed. Redirect mode keeps its
        // single-shot semantics — there 302 is the pass shape anyway.
        const raceRetryable = plan.publicOriginMode === 'worker'
        const maxAttempts = raceRetryable ? 6 : 1
        let response
        for (let attempt = 1; ; attempt += 1) {
          try {
            response = await withNetworkRetry(
              () => fetchImpl(imageUrl, { redirect: 'manual' }),
              { isRetriable: isThrownNetworkError, sleep: sleepImpl },
            )
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
          // §6.3 worker mode: with no bucket/CDN base the reader STREAMS the
          // image itself (200 + image/* from its own origin) — that is the
          // correct landing. Redirect mode keeps the 302-to-expected-origin
          // evidence. Anything else fails closed.
          const readerOrigin = new URL(reader.base).origin
          const contentType = (headerValue(response, 'content-type') ?? '').toLowerCase()
          const streamed =
            status === 200 && readerOrigin === expectedOrigin && contentType.startsWith('image/')
          const redirected = status === 302 && !!location && locationOrigin === expectedOrigin
          if (streamed) {
            receipts.push({ base: reader.base, streamed: true, contentType, attempts: attempt })
            break
          }
          if (redirected) {
            receipts.push({ base: reader.base, location, originMatches: true, attempts: attempt })
            break
          }
          if (raceRetryable && attempt < maxAttempts) {
            await sleepImpl(2_000 * attempt)
            continue
          }
          throw new Error(
            `image routing verification failed: ${reader.label} GET ${imageUrl} -> ${status || 'no response'} location=${location ?? '(none)'}; expected 302 to origin ${expectedOrigin} (or 200 image/* streamed from it) after ${attempt} attempt(s)`,
          )
        }
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
      if (isProduction) {
        return {
          dispatched: false,
          skipped: true,
          reason:
            'production first Full Sync is an explicit Owner dispatch (bootstrap flag + workflow_dispatch) outside apply',
        }
      }
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
      const ledger = ledgerFor(ctx)

      // The writer freeze is lifted ONLY inside this block
      // (enable → repo gate true → dispatch → verify → re-disable). A skipped
      // development job is never accepted as a pass.
      let receipt = null
      const restoreFailures = []
      try {
        const enableEntry = ledger.begin({
          op: 'workflow-state-change',
          stepId: 'single-writer-test',
          resourceType: 'github-workflow',
          target: `${workflow}:enabled`,
        })
        try {
          const alreadyEnabled = await runGhWorkflowToggle(
            spawnSyncImpl,
            ['workflow', 'enable', workflow, '--repo', repo],
            env,
          )
          if (alreadyEnabled) enableEntry.alreadyExists('workflow already active')
          else enableEntry.confirm('workflow enabled for single-writer test')
        } catch (error) {
          if (isAmbiguousTransportError(error)) enableEntry.unknown(error, `Check state of ${workflow}`)
          else enableEntry.fail(error)
          throw error
        }

        const openGateEntry = ledger.begin({
          op: 'authorization-gate-change',
          stepId: 'single-writer-test',
          resourceType: 'github-variable',
          target: `development:${DEVELOPMENT_WRITER_GATE_VAR}=true`,
        })
        try {
          await runGh(
            spawnSyncImpl,
            [
              'variable',
              'set',
              DEVELOPMENT_WRITER_GATE_VAR,
              '--env',
              'development',
              '--repo',
              repo,
              '--body',
              'true',
            ],
            env,
          )
          openGateEntry.confirm('opened development writer gate')
        } catch (error) {
          if (isAmbiguousTransportError(error)) openGateEntry.unknown(error, `Verify ${DEVELOPMENT_WRITER_GATE_VAR}=false`)
          else openGateEntry.fail(error)
          throw error
        }

        const before = parseGhJson(
          await runGh(
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

        await runGh(
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
            await runGh(
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
            await runGh(
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
          ['variable', 'set', DEVELOPMENT_WRITER_GATE_VAR, '--env', 'development', '--repo', repo, '--body', 'false'],
          ['workflow', 'disable', workflow, '--repo', repo],
        ]) {
          const isDisable = args[0] === 'workflow' && args[1] === 'disable'
          const restoreEntry = ledger.begin({
            op: isDisable ? 'workflow-state-change' : 'authorization-gate-change',
            stepId: 'single-writer-test',
            resourceType: isDisable ? 'github-workflow' : 'github-variable',
            target: isDisable ? `${workflow}:disabled` : `development:${DEVELOPMENT_WRITER_GATE_VAR}=false`,
            compensation: true,
          })
          try {
            if (isDisable) {
              await runGhWorkflowToggle(spawnSyncImpl, args, env)
            } else {
              await runGh(spawnSyncImpl, args, env)
            }
            restoreEntry.confirm('restored freeze state')
          } catch (error) {
            restoreEntry.compensationFailed(error, `Manually restore ${isDisable ? workflow : DEVELOPMENT_WRITER_GATE_VAR}`)
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
