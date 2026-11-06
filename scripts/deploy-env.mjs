#!/usr/bin/env node
/**
 * AIRINGCAL_ENV-driven deploy CLI (single-bucket development cutover).
 *
 * Dry-run is the safe default for production and when --apply is omitted.
 * Live Cloudflare / EdgeOne / GitHub mutations require --apply AND credentials.
 * Isolation proof failure aborts cutover — never falls back to dual-bucket.
 */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

import {
  DEVELOPMENT_DEFAULTS,
  applyStagingAliases,
  deriveDevelopmentConfig,
  evaluateIsolationProbe,
  loadDotEnvFile,
  missingScopeExitMessage,
  parseDeployArgs,
  redactSecrets,
  resolveExecutionMode,
} from './deploy-env-lib.mjs'

function usage(exitCode = 1) {
  console.error(`Usage:
  node scripts/deploy-env.mjs --dry-run [--target cloudflare|edgeone|both]
  node scripts/deploy-env.mjs --apply [--target cloudflare|edgeone|both]
  node scripts/deploy-env.mjs --apply --i-am-sure-production   # production only

Env: AIRINGCAL_ENV=development|production (required)
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

/**
 * Apply path for development. Without live credentials this refuses to mutate
 * and exits non-zero with an Owner-gated checklist (safe by design).
 */
async function applyDevelopment({ env, plan, derived }) {
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

  // Live apply is intentionally incomplete without Owner-approved cloud ops in
  // this change. Token presence alone is not enough to mutate; require an
  // explicit confirmation env so CI/local dry paths cannot half-cutover.
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
        ],
      }),
      secretsPresent: derived.secretsPresent,
    }
    process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`)
    process.exitCode = 2
    return
  }

  throw new Error(
    'Live cloud apply path is Owner-gated in this slice; unset AIRINGCAL_DEPLOY_LIVE_CONFIRM and use --dry-run, or complete Task 4.4 with Owner DNS/token approval before mutating.',
  )
}

async function main(argv = process.argv) {
  let flags
  try {
    flags = parseDeployArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    usage(1)
    return
  }

  const dotenvPath = resolve(process.env.AIRINGCAL_DOTENV_PATH ?? '.env')
  const loaded = loadDotEnvFile(dotenvPath, process.env)
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

  const target =
    flags.target !== 'both'
      ? flags.target
      : String(env.AIRINGCAL_DEPLOY_TARGET ?? 'both').trim() || 'both'

  if (envName === 'production') {
    const productionPlan = {
      env: 'production',
      mode: execution.mode,
      reason: execution.reason,
      target,
      refusedMutations: execution.mode !== 'apply',
      note:
        'Production bootstrap stays out of scope for this change. Development cutover uses airingcal-development only.',
      steps: [
        {
          id: 'refuse-or-owner-force',
          title:
            execution.mode === 'apply'
              ? 'Owner-forced production apply (not implemented in this slice)'
              : 'Dry-run only — pass --apply --i-am-sure-production to force (still Owner-gated)',
        },
      ],
    }
    process.stdout.write(`${JSON.stringify(productionPlan, null, 2)}\n`)
    if (execution.mode === 'apply') {
      console.error(
        'Production --apply is Owner-gated and not implemented in Task 4.2; no mutations performed.',
      )
      process.exitCode = 2
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

  await applyDevelopment({ env, plan, derived })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

export { main }
