/**
 * Live Cloudflare / GitHub / EdgeOne I/O adapters for deploy-env --apply.
 *
 * Injectable via createLiveDevelopmentApplyIo({ spawnSyncImpl, fetchImpl, … }).
 * Unit tests must not hit live cloud — pass spawn/fetch doubles.
 */
import { createHash, randomUUID } from 'node:crypto'
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
    return { created: false, reused: true, rulesetId: entry.id, ruleId: existing.id }
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
        throw new Error('Cloudflare API token required to derive R2 S3 credentials')
      }

      const tokenName = `airingcal-deploy-r2-${randomUUID().slice(0, 8)}`
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
      const created = await cfApi(fetchImpl, parentToken, '/user/tokens', {
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
        `[deploy-env] Derived R2 S3 Access Key ID ${accessKeyId} (secret redacted)\n`,
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

      const immutable = await ensureZonePhaseRule({
        fetchImpl,
        token,
        zoneId,
        phase: 'http_request_cache_settings',
        description: 'airingcal-images-snapshots-immutable',
        expression:
          '(starts_with(http.request.uri.path, "/images/") or starts_with(http.request.uri.path, "/snapshots/"))',
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
        expression: '(http.request.uri.path eq "/public/current-release.json")',
        action: 'set_cache_settings',
        actionParameters: {
          cache: false,
        },
      })
      return { ok: true, zoneId, immutable, pointer }
    },

    async applyCors() {
      const origins = plan.cors?.allowedOrigins ?? []
      const methods = plan.cors?.methods ?? ['GET', 'HEAD', 'OPTIONS']
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

      const rule = await ensureZonePhaseRule({
        fetchImpl,
        token,
        zoneId,
        phase: 'http_request_firewall_custom',
        description: 'airingcal-deny-checkpoints',
        expression: '(starts_with(http.request.uri.path, "/checkpoints/"))',
        action: 'block',
        actionParameters: {
          response: {
            status_code: 403,
            content: 'Forbidden',
            content_type: 'text/plain',
          },
        },
      })
      return { ok: true, zoneId, rule }
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
      for (const [key, value] of envPairs) {
        const setRes = spawnSyncImpl(
          'edgeone',
          ['makers', 'env', 'set', key, value, '-e', 'production', '-t', token],
          { encoding: 'utf8', cwd: ROOT, env: { ...process.env, ...env } },
        )
        assertSpawnOk(setRes, `edgeone makers env set ${key}`, secrets)
      }

      return { deployed: true, project, region, createdViaDeploy: true }
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
            'Set AIRINGCAL_DEPLOY_WRITER_TEST=yes to dispatch one target=development run after isolation+copy',
        }
      }

      runGh(
        spawnSyncImpl,
        [
          'workflow',
          'run',
          'portable-writer.yml',
          '--repo',
          repo,
          '-f',
          'target=development',
        ],
        env,
      )
      return { dispatched: true, target: 'development', developmentWriterEnabled: false }
    },
  }
}
