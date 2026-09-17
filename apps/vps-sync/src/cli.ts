#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBackup, type BackupDependencies } from './backup/backup.js'
import type { RunDependencies, RunRequest, RunResult } from './contracts.js'
import { exitCode, runOnce } from './run.js'
import { deliverNotification, type NotificationDeliveryConfig } from './notification/deliver.js'

export type RunOnceWithBackupDependencies = Omit<RunDependencies, 'backup'> & {
  backupConfig: BackupDependencies
}

export type SyncDependencies = Omit<RunOnceWithBackupDependencies, 'notify'>

const HELP = `Usage: sync [--mode=shadow|live] [--source=scheduled|manual]`

/** Reads only the process configuration needed by the real Feishu notifier. */
export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotificationDeliveryConfig {
  const webhookUrl = env.FEISHU_WEBHOOK_URL
  if (!webhookUrl) throw new Error('FEISHU_WEBHOOK_URL_REQUIRED')
  const timeoutMs = env.FEISHU_TIMEOUT_MS === undefined ? undefined : Number(env.FEISHU_TIMEOUT_MS)
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)) {
    throw new Error('FEISHU_TIMEOUT_INVALID')
  }
  return {
    webhookUrl,
    ...(env.FEISHU_WEBHOOK_TOKEN === undefined ? {} : { token: env.FEISHU_WEBHOOK_TOKEN }),
    ...(env.FEISHU_WEBHOOK_SECRET === undefined ? {} : { secret: env.FEISHU_WEBHOOK_SECRET }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

/** The production notifier is deliberately explicit: no default/no-op notifier exists. */
export function createFeishuNotifier(config: NotificationDeliveryConfig): RunDependencies['notify'] {
  return (result) => deliverNotification(config, result)
}

export function parseSyncRequest(argv: readonly string[] = ['sync']): RunRequest {
  if (argv[0] !== 'sync') throw new Error('SYNC_COMMAND_REQUIRED')
  let mode: RunRequest['mode'] = 'shadow'
  let source: RunRequest['source'] = 'scheduled'
  for (const argument of argv.slice(1)) {
    if (argument === '--help') throw new Error('SYNC_HELP')
    const [flag, value] = argument.split('=', 2)
    if (flag === '--mode' && (value === 'shadow' || value === 'live')) mode = value
    else if (flag === '--source' && (value === 'scheduled' || value === 'manual')) source = value
    else throw new Error('SYNC_ARGUMENT_INVALID')
  }
  return { mode, source }
}

/** Injectable production composition; the executable sync command is enabled with its notifier in Task 6.2. */
export async function runOnceWithBackup(
  deps: RunOnceWithBackupDependencies,
  request: RunRequest,
): Promise<RunResult> {
  if (typeof deps.notify !== 'function') throw new Error('NOTIFIER_REQUIRED')

  const runDependencies: RunDependencies = {
    ...deps,
    backup: async (context) => {
      await createBackup(deps.backupConfig, { runId: context.runId, gitSha: deps.gitSha })
    },
  }
  return runOnce(runDependencies, request)
}

/** Injectable executable `sync` entrypoint; it always installs the real Feishu delivery port. */
export function createSyncEntrypoint(
  deps: SyncDependencies,
  notification: NotificationDeliveryConfig,
): (argv?: readonly string[]) => Promise<number> {
  return async (argv = ['sync']) => {
    if (argv.includes('--help')) {
      process.stdout.write(`${HELP}\n`)
      return 0
    }
    const request = parseSyncRequest(argv)
    const result = await runOnceWithBackup({ ...deps, notify: createFeishuNotifier(notification) }, request)
    return exitCode(result.status)
  }
}

/** Named command entrypoint used by the one-shot runtime and by executable wrappers. */
export async function sync(
  deps: SyncDependencies,
  notification: NotificationDeliveryConfig,
  argv: readonly string[] = ['sync'],
): Promise<number> {
  return createSyncEntrypoint(deps, notification)(argv)
}

/** Process-facing wrapper for a deployment/runtime adapter to invoke with process.argv. */
export async function main(
  deps?: SyncDependencies,
  notification?: NotificationDeliveryConfig,
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  if (argv.includes('--help')) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (!deps) throw new Error('SYNC_RUNTIME_REQUIRED')
  return sync(deps, notification ?? feishuConfigFromEnv(env), argv)
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  }).catch(() => {
    process.stderr.write('sync runtime unavailable\n')
    process.exitCode = 1
  })
}
