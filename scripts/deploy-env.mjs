#!/usr/bin/env node
/**
 * AIRINGCAL_ENV-driven deploy CLI (single-bucket development cutover).
 *
 * Dry-run is the safe default for production and when --apply is omitted.
 * Live Cloudflare / EdgeOne / GitHub mutations require --apply AND credentials.
 * Isolation proof failure aborts cutover — never falls back to dual-bucket.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'


import {
  DEVELOPMENT_DEFAULTS,
  applyStagingAliases,
  deriveDevelopmentConfig,
  deriveProductionConfig,
  evaluateIsolationProbe,
  loadDotEnvFile,
  loadProductionDeployEnv,
  missingScopeExitMessage,
  mutationsExecutedFrom,
  parseDeployArgs,
  redactSecrets,
  resolveDeployDotenvPath,
  resolveExecutionMode,
  runDevelopmentApply,
  runProductionApply,
} from './deploy-env-lib.mjs'
import { createLiveDevelopmentApplyIo as createLiveIoAdapters } from './deploy-env-live-io.mjs'

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/deploy-env.mjs --dry-run [--target cloudflare|edgeone|both]
  node scripts/deploy-env.mjs --apply [--target cloudflare|edgeone|both]
  node scripts/deploy-env.mjs --apply --i-am-sure-production   # production only

Env: AIRINGCAL_ENV=development|production (required)
Production: AIRINGCAL_DOTENV_PATH must point at .env.production (file overrides shell; no STAGING_/DEVELOPMENT_ inheritance)
`)
  process.exit(exitCode)
}

function secretListFromEnv(env) {
  return [
    env.AIRINGCAL_CLOUDFLARE_API_TOKEN,
    env.CLOUDFLARE_API_TOKEN,
    env.AIRINGCAL_STAGING_CLOUDFLARE_API_TOKEN,
    env.AIRINGCAL_BANGUMI_TOKEN,
    env.AIRINGCAL_STAGING_BANGUMI_TOKEN,
    env.AIRINGCAL_S3_ACCESS_KEY_ID,
    env.AIRINGCAL_S3_SECRET_ACCESS_KEY,
    env.AIRINGCAL_STAGING_S3_ACCESS_KEY_ID,
    env.AIRINGCAL_STAGING_S3_SECRET_ACCESS_KEY,
    env.AIRINGCAL_EDGEONE_API_TOKEN,
  ]
}

function resolveGitSha(cwd = process.cwd()) {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd,
    })
    if (result.status !== 0) return null
    const sha = String(result.stdout ?? '').trim()
    return sha || null
  } catch {
    return null
  }
}

function createLiveDevelopmentApplyIo(options = {}) {
  return createLiveIoAdapters(options)
}

/**
 * Apply path for development. Without live credentials this refuses to mutate
 * and exits non-zero with an Owner-gated checklist (safe by design).
 * With credentials + AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes, runs the injectable
 * step sequence (abort before copy on isolation failure).
 */
async function applyDevelopment({ env, plan, derived, io }) {
  const token = String(
    env.AIRINGCAL_CLOUDFLARE_API_TOKEN ?? env.CLOUDFLARE_API_TOKEN ?? '',
  ).trim()

  if (!token) {
    const pending = {
      status: 'owner-gated',
      reason:
        'AIRINGCAL_CLOUDFLARE_API_TOKEN absent; refusing live mutations. Re-run with credentials or use --dry-run.',
      plan,
      pendingOwnerSteps: plan.ownerGatedLiveSteps,
      isolationAbortPolicy: {
        abortOnFailure: true,
        dualBucketFallback: false,
        probeKey: DEVELOPMENT_DEFAULTS.isolationProbeKey,
      },
      writerFreeze: plan.writerFreeze,
      developmentWriterEnabled: false,
    }
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  if (String(env.AIRINGCAL_DEPLOY_LIVE_CONFIRM ?? '').trim() !== 'yes') {
    const pending = {
      status: 'owner-gated',
      reason:
        'Token present but AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes not set; printing plan and refusing mutations.',
      missingScopesHint: missingScopeExitMessage([
        'Workers R2 Storage Write',
        'Workers Scripts Write',
        'R2 S3 API token derivation',
      ]),
      plan,
      pendingOwnerSteps: plan.ownerGatedLiveSteps,
      evaluateIsolationProbeExample: evaluateIsolationProbe({
        r2DevDisabled: true,
        probes: [
          {
            url: `${plan.publicBaseUrl}/${DEVELOPMENT_DEFAULTS.isolationProbeKey}`,
            method: 'GET',
            status: 403,
          },
          {
            url: `${plan.publicBaseUrl}/${DEVELOPMENT_DEFAULTS.isolationProbeKey}`,
            method: 'HEAD',
            status: 403,
          },
        ],
      }),
      secretsPresent: derived.secretsPresent,
    }
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  const applyIo = io ?? createLiveDevelopmentApplyIo({ env, plan })
  const result = await runDevelopmentApply({ plan, env, io: applyIo })
  process.stdout.write(
    `${JSON.stringify({ status: result.ok ? 'applied' : 'aborted', ...result, mutationsExecuted: mutationsExecutedFrom(result.completed) }, null, 2)}\n`,
  )
  if (!result.ok) {
    process.exitCode = result.exitCode ?? 1
  }
}

async function main(argv = process.argv, options = {}) {
  let flags
  try {
    flags = parseDeployArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    usage(1)
    return
  }
  // Resolve dotenv path. Production forbids the Development default `.env` and
  // requires basename `.env.production`. Development keeps `.env` default.
  let dotenvPath
  try {
    const hintedEnv = String(process.env.AIRINGCAL_ENV ?? '').trim().toLowerCase()
    dotenvPath = resolve(
      resolveDeployDotenvPath({
        envName: hintedEnv || 'development',
        dotenvPathEnv: process.env.AIRINGCAL_DOTENV_PATH,
      }),
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  // Peek AIRINGCAL_ENV from the chosen file (without shell override) so we can
  // pick Production file-over-shell loading vs Development shell-wins loading.
  const filePeek = loadDotEnvFile(dotenvPath, {}, { override: true })
  const fileEnvName = String(filePeek.AIRINGCAL_ENV ?? process.env.AIRINGCAL_ENV ?? '')
    .trim()
    .toLowerCase()

  let loaded
  try {
    if (fileEnvName === 'production') {
      // Re-validate path against production rules even if shell AIRINGCAL_ENV was unset/mis-set.
      dotenvPath = resolve(
        resolveDeployDotenvPath({
          envName: 'production',
          dotenvPathEnv: process.env.AIRINGCAL_DOTENV_PATH,
        }),
      )
      loaded = loadProductionDeployEnv(dotenvPath, process.env)
    } else {
      loaded = loadDotEnvFile(dotenvPath, process.env)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  const { env, warnings } = applyStagingAliases(loaded)
  for (const warning of warnings) {
    console.error(`[deploy-env] ${warning}`)
  }

  const envName = String(env.AIRINGCAL_ENV ?? '').trim().toLowerCase()
  if (!envName) {
    console.error('AIRINGCAL_ENV is required (development|production)')
    usage(1)
    return
  }

  let execution
  try {
    execution = resolveExecutionMode({
      envName,
      dryRun: flags.dryRun,
      apply: flags.apply,
      forceProduction: flags.forceProduction,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }

  const target = flags.targetExplicit
    ? flags.target
    : String(env.AIRINGCAL_DEPLOY_TARGET ?? flags.target ?? 'both').trim() || 'both'

  if (envName === 'production') {
    let derived
    try {
      derived = deriveProductionConfig(env, {
        target,
        mode: execution.mode,
        gitSha: resolveGitSha(),
      })
    } catch (error) {
      console.error(
        redactSecrets(error instanceof Error ? error.message : String(error), secretListFromEnv(env)),
      )
      process.exitCode = 1
      return
    }

    // The plan object is printed at every exit point. `refusedMutations`
    // describes THIS print (true until the executor starts); once the apply
    // runs, the result JSON printed afterwards is authoritative and carries
    // `mutationsExecuted` — the completed steps that could touch external
    // state. A failure in step one therefore reports mutationsExecuted: []
    // even though the plan printed `false` earlier (ShipReview #10).
    const plan = {
      ...derived.plan,
      mode: execution.mode,
      reason: execution.reason,
      applyAuthorized: derived.applyAuthorized,
      writerEnabled: false,
      productionWriterEnabled: false,
      bootstrapWriterEnabled: false,
      refusedMutations: true,
    }

    if (execution.mode === 'dry-run') {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      if (derived.missingCloudflareToken) {
        console.error(
          '[deploy-env] note: Cloudflare token absent — production dry-run plan only; live --apply stays unauthorized without AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes.',
        )
      }
      return
    }

    // Apply path: three explicit gates — --apply --i-am-sure-production
    // (resolveExecutionMode), AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes and
    // AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes. Everything else is the same
    // injectable step machinery as development, with the production plan's
    // copy-free / empty-bucket / production-environment semantics enforced by
    // runProductionApply and the environment-aware live adapters.
    if (!derived.applyAuthorized) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      console.error(
        'not_authorized_in_this_change: Production --apply refused without AIRINGCAL_PRODUCTION_APPLY_AUTHORIZED=yes; no mutations performed.',
      )
      process.exitCode = 2
      return
    }

    if (String(env.AIRINGCAL_DEPLOY_LIVE_CONFIRM ?? '').trim() !== 'yes') {
      const pending = {
        status: 'owner-gated',
        reason:
          'Production apply authorized but AIRINGCAL_DEPLOY_LIVE_CONFIRM=yes not set; printing plan and refusing mutations.',
        plan: { ...plan },
        pendingOwnerSteps: plan.ownerGatedLiveSteps,
        writerEnabled: false,
        productionWriterEnabled: false,
        bootstrapWriterEnabled: false,
      }
      process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
      process.exitCode = 2
      return
    }

    process.stdout.write(`${JSON.stringify({ ...plan, refusedMutations: false }, null, 2)}\n`)
    const applyIo = options.io ?? createLiveDevelopmentApplyIo({ env, plan })
    const result = await runProductionApply({ plan, env, io: applyIo })
    process.stdout.write(
      `${JSON.stringify({ status: result.ok ? 'applied' : 'aborted', ...result, mutationsExecuted: mutationsExecutedFrom(result.completed) }, null, 2)}\n`,
    )
    if (!result.ok) {
      process.exitCode = result.exitCode ?? 1
    }
    return
  }

  let derived
  try {
    derived = deriveDevelopmentConfig(env, { target, mode: execution.mode })
  } catch (error) {
    console.error(
      redactSecrets(error instanceof Error ? error.message : String(error), secretListFromEnv(env)),
    )
    process.exitCode = 1
    return
  }

  const plan = derived.plan

  if (execution.mode === 'dry-run') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    if (derived.missingCloudflareToken) {
      console.error(
        '[deploy-env] note: Cloudflare token absent — dry-run plan only; live --apply is Owner-gated.',
      )
    }
    return
  }

  await applyDevelopment({ env, plan, derived, io: options.io })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { main, applyDevelopment, createLiveDevelopmentApplyIo }
