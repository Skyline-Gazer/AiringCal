import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  CloudflareKvExportClient,
  KV_LIST_KEYS_MAX_LIMIT,
  LEGACY_KV_KEY_PREFIXES,
} from '../adapters/cloudflare-kv-export.ts'

export interface LegacyExportCliArgs {
  outPath?: string
  accountId?: string
  namespaceId?: string
  apiToken?: string
  prefixes?: string[]
  pageLimit?: number
  allowEmpty: boolean
}

function parsePositiveDecimal(value: string, label: string): number {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) throw new Error(`Invalid ${label}: ${value}`)
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label}: ${value}`)
  return parsed
}

export function parseLegacyExportArgs(argv: string[]): LegacyExportCliArgs {
  const args: LegacyExportCliArgs = { allowEmpty: false }
  const prefixes: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--allow-empty') {
      args.allowEmpty = true
      continue
    }
    if (['--out', '--account-id', '--namespace-id', '--api-token', '--prefix', '--page-limit'].includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      index += 1
      if (arg === '--out') args.outPath = value
      if (arg === '--account-id') args.accountId = value
      if (arg === '--namespace-id') args.namespaceId = value
      if (arg === '--api-token') args.apiToken = value
      if (arg === '--prefix') prefixes.push(value)
      if (arg === '--page-limit') {
        const limit = parsePositiveDecimal(value, 'page limit')
        if (limit < 10 || limit > KV_LIST_KEYS_MAX_LIMIT) {
          throw new Error(`--page-limit must be between 10 and ${KV_LIST_KEYS_MAX_LIMIT}`)
        }
        args.pageLimit = limit
      }
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }
  if (prefixes.length > 0) args.prefixes = prefixes
  return args
}

export interface LegacyExportDeps {
  env?: Record<string, string | undefined>
  /** Test/DI seam; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Resolves credentials from flags, falling back to the documented operator env names. */
export function resolveLegacyExportCredentials(
  args: LegacyExportCliArgs,
  env: Record<string, string | undefined> = process.env,
): { accountId: string; namespaceId: string; apiToken: string } {
  const accountId = args.accountId ?? env.CLOUDFLARE_ACCOUNT_ID
  const namespaceId = args.namespaceId ?? env.AIRING_CAL_KV_NAMESPACE_ID
  const apiToken = args.apiToken ?? env.CLOUDFLARE_API_TOKEN
  const missing = [
    accountId ? null : 'account id (--account-id or CLOUDFLARE_ACCOUNT_ID)',
    namespaceId ? null : 'KV namespace id (--namespace-id or AIRING_CAL_KV_NAMESPACE_ID)',
    apiToken ? null : 'API token (--api-token or CLOUDFLARE_API_TOKEN)',
  ].filter((entry): entry is string => entry !== null)
  if (!accountId || !namespaceId || !apiToken) {
    throw new Error(`Missing Cloudflare credential: ${missing.join(', ')}`)
  }
  return { accountId, namespaceId, apiToken }
}

export interface LegacyExportResult {
  outPath: string
  keyCount: number
  prefixes: Record<string, number>
}

/**
 * Read-only export of the legacy v2 KV entries consumed by
 * `portable-legacy-state-import` (#73). Writes only the local JSON file; no
 * Cloudflare write, no public-store access.
 */
export async function runLegacyExport(
  args: LegacyExportCliArgs,
  deps: LegacyExportDeps = {},
): Promise<LegacyExportResult> {
  const outPath = args.outPath
  if (!outPath) throw new Error('--out <path> is required')
  const credentials = resolveLegacyExportCredentials(args, deps.env ?? process.env)
  const client = new CloudflareKvExportClient({
    ...credentials,
    pageLimit: args.pageLimit,
    fetchImpl: deps.fetchImpl,
  })
  const exported = await client.exportLegacyEntries(args.prefixes ?? LEGACY_KV_KEY_PREFIXES)
  if (exported.keyCount === 0 && !args.allowEmpty) {
    throw new Error(
      'No legacy KV entries found; check the namespace id/prefixes or pass --allow-empty to export an empty file',
    )
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(exported.entries, null, 2)}\n`)
  return { outPath, keyCount: exported.keyCount, prefixes: exported.prefixes }
}

if (process.argv[1]?.endsWith('portable-legacy-export.ts')) {
  void (async () => {
    try {
      const args = parseLegacyExportArgs(process.argv.slice(2))
      if (!args.outPath) {
        throw new Error(
          'Usage: portable-legacy-export.ts --out <kv-export.json> [--account-id <id>] [--namespace-id <id>] '
          + '[--prefix <p>] [--page-limit N] [--allow-empty]',
        )
      }
      const result = await runLegacyExport(args)
      console.log(JSON.stringify({
        status: 'ok',
        stage: 'legacy_export',
        out: result.outPath,
        key_count: result.keyCount,
        prefixes: result.prefixes,
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'export_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'legacy_export', message }))
      process.exit(1)
    }
  })()
}
