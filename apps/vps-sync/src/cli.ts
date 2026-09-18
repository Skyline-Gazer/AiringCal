#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBackup, type BackupDependencies } from './backup/backup.js'
import type { RunDependencies, RunRequest, RunResult } from './contracts.js'
import { exitCode, runOnce } from './run.js'
import { deliverNotification, type NotificationDeliveryConfig } from './notification/deliver.js'

export type MigrationCommand =
  | { command: 'shadow-compare'; mode: 'shadow'; dryRun: boolean }
  | { command: 'restore-verify'; backupKey: string; targetEnv: string; dryRun: boolean }
  | { command: 'cutover'; mode: 'live'; approvalTokenEnv: string; dryRun: boolean }
  | { command: 'rollback'; mode: 'live'; manifestKey: string; dryRun: boolean }

export type MigrationCommandRunner = (request: MigrationCommand) => Promise<unknown>

export type RunOnceWithBackupDependencies = Omit<RunDependencies, 'backup'> & {
  backupConfig: BackupDependencies
}

export type SyncDependencies = Omit<RunOnceWithBackupDependencies, 'notify'>

const HELP = `Usage: sync [--mode=shadow|live] [--source=scheduled|manual]`
const MIGRATION_HELP: Record<MigrationCommand['command'], string> = {
  'shadow-compare': 'Usage: shadow-compare --mode=shadow [--dry-run]',
  'restore-verify': 'Usage: restore-verify --backup-key=<r2-key> --target-env=<env-name> [--dry-run]',
  cutover: 'Usage: cutover --mode=live --approval-token-env=<env-name> [--dry-run]',
  rollback: 'Usage: rollback --mode=live --manifest-key=<r2-key> [--dry-run]',
}

/** Reads only the process configuration needed by the real Feishu notifier. */
export function feishuConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotificationDeliveryConfig {
  const webhookUrl = env.FEISHU_WEBHOOK_URL
  if (!webhookUrl) throw new Error('FEISHU_WEBHOOK_URL_REQUIRED')
  const token = env.FEISHU_WEBHOOK_TOKEN?.trim() ? env.FEISHU_WEBHOOK_TOKEN : undefined
  const timeoutMs = env.FEISHU_TIMEOUT_MS === undefined ? undefined : Number(env.FEISHU_TIMEOUT_MS)
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)) {
    throw new Error('FEISHU_TIMEOUT_INVALID')
  }
  return {
    webhookUrl,
    ...(token === undefined ? {} : { token }),
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

function requiredValue(argument: string, flag: string): string {
  const prefix = `${flag}=`
  if (!argument.startsWith(prefix)) throw new Error('MIGRATION_ARGUMENT_INVALID')
  const value = argument.slice(prefix.length)
  if (!value) throw new Error('MIGRATION_ARGUMENT_INVALID')
  return value
}

function environmentName(value: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(value)) throw new Error('MIGRATION_ENV_NAME_INVALID')
  return value
}

export function migrationHelp(command?: string): string {
  if (command && Object.hasOwn(MIGRATION_HELP, command)) return MIGRATION_HELP[command as MigrationCommand['command']]
  return Object.values(MIGRATION_HELP).join('\n')
}

export function parseMigrationRequest(argv: readonly string[]): MigrationCommand {
  const command = argv[0]
  if (command !== 'shadow-compare' && command !== 'restore-verify' && command !== 'cutover' && command !== 'rollback') {
    throw new Error('MIGRATION_COMMAND_REQUIRED')
  }

  let dryRun = false
  let mode: 'shadow' | 'live' | undefined
  let backupKey: string | undefined
  let targetEnv: string | undefined
  let approvalTokenEnv: string | undefined
  let manifestKey: string | undefined
  for (const argument of argv.slice(1)) {
    if (argument === '--dry-run') {
      dryRun = true
      continue
    }
    if (argument.startsWith('--mode=')) {
      const value = argument.slice('--mode='.length)
      if (value !== 'shadow' && value !== 'live') throw new Error('MIGRATION_MODE_INVALID')
      mode = value
      continue
    }
    if (argument.startsWith('--backup-key=')) {
      backupKey = requiredValue(argument, '--backup-key')
      continue
    }
    if (argument.startsWith('--target-env=')) {
      targetEnv = environmentName(requiredValue(argument, '--target-env'))
      continue
    }
    if (argument.startsWith('--approval-token-env=')) {
      approvalTokenEnv = environmentName(requiredValue(argument, '--approval-token-env'))
      continue
    }
    if (argument.startsWith('--manifest-key=')) {
      manifestKey = requiredValue(argument, '--manifest-key')
      continue
    }
    throw new Error('MIGRATION_ARGUMENT_INVALID')
  }

  if (command === 'shadow-compare') {
    if (mode !== 'shadow') throw new Error('SHADOW_MODE_REQUIRED')
    return { command, mode, dryRun }
  }
  if (command === 'restore-verify') {
    if (!backupKey || !targetEnv) throw new Error('RESTORE_ARGUMENT_REQUIRED')
    return { command, backupKey, targetEnv, dryRun }
  }
  if (mode !== 'live') throw new Error('LIVE_MODE_REQUIRED')
  if (command === 'cutover') {
    if (!approvalTokenEnv) throw new Error('CUTOVER_APPROVAL_ENV_REQUIRED')
    return { command, mode, approvalTokenEnv, dryRun }
  }
  if (!manifestKey) throw new Error('ROLLBACK_MANIFEST_REQUIRED')
  return { command, mode, manifestKey, dryRun }
}

export function createMigrationEntrypoint(
  runner: MigrationCommandRunner,
): (argv?: readonly string[]) => Promise<number> {
  return async (argv = []) => {
    if (argv.includes('--help')) {
      process.stdout.write(`${migrationHelp(argv[0])}\n`)
      return 0
    }
    const result = await runner(parseMigrationRequest(argv))
    const output = JSON.stringify(result)
    if (output !== undefined) process.stdout.write(`${output}\n`)
    return 0
  }
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
  migrationRunner?: MigrationCommandRunner,
): Promise<number> {
  if (argv.includes('--help')) {
    if (argv[0] === undefined || argv[0] === 'sync' || argv[0] === '--help') {
      process.stdout.write(`${HELP}\n`)
      return 0
    }
    process.stdout.write(`${migrationHelp(argv[0])}\n`)
    return 0
  }
  if (argv[0] !== undefined && argv[0] !== 'sync') {
    if (!migrationRunner) throw new Error('MIGRATION_RUNTIME_REQUIRED')
    return createMigrationEntrypoint(migrationRunner)(argv)
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
