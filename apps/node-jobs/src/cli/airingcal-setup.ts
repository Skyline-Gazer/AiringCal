import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline/promises'
import {
  formatPortableEnvLines,
  loadAiringcalConfigFromFile,
  portableEnvFromAiringcalConfig,
  type AiringcalPlatform,
} from '@airing-cal/v3-adapters'

export const PORTABLE_SECRET_ENV_KEYS = [
  'BGM_TOKEN',
  'AIRINGCAL_USERS_JSON',
  'AIRINGCAL_PRIMARY_USER_ID',
] as const

/**
 * Secrets/env an operator must supply per supported platform; the config file
 * itself holds none of them. `edgeone` is absent because setup fails closed
 * there while the adapter is a stub.
 */
export const PLATFORM_SECRET_ENV_KEYS: Record<Exclude<AiringcalPlatform, 'edgeone'>, readonly string[]> = {
  portable: PORTABLE_SECRET_ENV_KEYS,
  cloudflare: [...PORTABLE_SECRET_ENV_KEYS, 'CLOUDFLARE_API_TOKEN'],
}

export interface AiringcalSetupResult {
  platform: AiringcalPlatform
  env_lines: string
  secrets_required: readonly string[]
  /** Non-secret bindings/resources the platform declares outside this config (e.g. wrangler.toml). */
  bindings_required: readonly string[]
}

/**
 * Non-interactive setup: validates the operator config (JSON or `airingcal.yaml`)
 * and reports the env an operator must provide. Secrets stay in the environment —
 * nothing secret is written to the emitted env lines.
 */
export function runAiringcalSetup(
  configPath: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AiringcalSetupResult {
  const config = loadAiringcalConfigFromFile(configPath, readFile)
  switch (config.platform) {
    case 'portable':
      return {
        platform: 'portable',
        env_lines: formatPortableEnvLines(portableEnvFromAiringcalConfig(config)),
        secrets_required: PLATFORM_SECRET_ENV_KEYS.portable,
        bindings_required: [],
      }
    case 'cloudflare':
      // The Cloudflare read worker declares its R2 binding in wrangler.toml; the
      // release is still built by the portable/Compose builder.
      return {
        platform: 'cloudflare',
        env_lines: formatPortableEnvLines({ AIRINGCAL_PLATFORM: 'cloudflare' }),
        secrets_required: PLATFORM_SECRET_ENV_KEYS.cloudflare,
        bindings_required: ['wrangler.toml: [[r2_buckets]] binding = "AIRINGCAL_PUBLIC_R2"'],
      }
    case 'edgeone':
      throw new Error('airingcal setup does not support platform edgeone yet; the EdgeOne adapter is a stub (#72)')
  }
}

if (process.argv[1]?.endsWith('airingcal-setup.ts')) {
  const argv = process.argv.slice(2)
  const valueOf = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const configPath = argv.find((arg, index) => !arg.startsWith('--') && !argv[index - 1]?.startsWith('--'))
  const emitEnv = argv.includes('--emit-env')
  const interactive = argv.includes('--interactive')
  const secretsOut = valueOf('--secrets-out')
  void (async () => {
    try {
      if (!configPath) {
        throw new Error('Usage: airingcal-setup.ts <airingcal.yaml|.json> [--emit-env] [--interactive --secrets-out <path>]')
      }
      const result = runAiringcalSetup(configPath)
      if (emitEnv) process.stdout.write(result.env_lines)

      let secrets: InteractiveSecretsResult | null = null
      if (interactive) {
        const reader = createInterface({ input: process.stdin, output: process.stderr })
        try {
          secrets = await runInteractiveSecretsSetup(result.secrets_required, secretsOut, {
            prompt: (key) => askOrSkipOnClose(reader, key),
            writeFile: (path, content, mode) => writeFileSync(path, content, { mode }),
          })
        } finally {
          reader.close()
        }
      }

      console.log(JSON.stringify({
        status: 'ok',
        stage: 'airingcal_setup',
        platform: result.platform,
        secrets_required: result.secrets_required,
        bindings_required: result.bindings_required,
        emitted_env: emitEnv,
        interactive,
        secrets: secrets === null ? null : { written: secrets.written, skipped: secrets.skipped, path: secrets.secretsPath },
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'setup_failed'
      console.error(JSON.stringify({ status: 'failed', stage: 'airingcal_setup', message }))
      process.exit(1)
    }
  })()
}

export interface InteractiveSecretsDeps {
  /** Returns the entered value, or null at EOF/skip. */
  prompt: (key: string) => Promise<string | null>
  writeFile: (path: string, content: string, mode: number) => void
}

/**
 * `readline.question` never settles once stdin reaches EOF with piped input,
 * which would leave setup hanging or crashing; normalising both to "skip this
 * secret" keeps interactive and piped runs behaving the same.
 */
async function askOrSkipOnClose(reader: Interface, key: string): Promise<string | null> {
  const closed = Promise.withResolvers<null>()
  reader.once('close', () => closed.resolve(null))
  const question = reader.question(`Enter ${key} (blank to skip): `).catch(() => null)
  const answer = await Promise.race([question, closed.promise])
  return answer ?? null
}

export interface InteractiveSecretsResult {
  written: string[]
  skipped: string[]
  secretsPath: string | null
}

/**
 * Interactive secret entry: prompts for each required key and writes the
 * non-empty answers to `secretsPath` with `0600` permissions. Values are never
 * printed and never touch the emitted (non-secret) env lines.
 */
export async function runInteractiveSecretsSetup(
  secretsRequired: readonly string[],
  secretsPath: string | undefined,
  deps: InteractiveSecretsDeps,
): Promise<InteractiveSecretsResult> {
  const written: string[] = []
  const entries: string[] = []
  const skipped: string[] = []
  for (const key of secretsRequired) {
    const value = (await deps.prompt(key))?.trim() ?? ''
    if (value.length === 0) {
      skipped.push(key)
      continue
    }
    written.push(key)
    entries.push(`${key}=${value}`)
  }
  if (entries.length === 0) return { written, skipped, secretsPath: null }
  if (!secretsPath) {
    throw new Error('--secrets-out <path> is required to store interactively entered secrets')
  }
  deps.writeFile(secretsPath, `${entries.join('\n')}\n`, 0o600)
  return { written, skipped, secretsPath }
}
