/**
 * Materializes a **staging-only** Wrangler config for `apps/v3-read-worker` (#147 C8).
 *
 * The checked-in `wrangler.toml` points at the production public-release bucket
 * (`airing-cal-public`). A staging deploy must never read it: this script rewrites
 * the `AIRINGCAL_PUBLIC_R2` bucket, injects the verified public base URL as a var,
 * and rewrites `main` relative to the output file (Wrangler resolves `main` from
 * the config directory).
 *
 * Usage:
 *   AIRINGCAL_STAGING_PUBLIC_R2_BUCKET=... \
 *   AIRINGCAL_STAGING_PUBLIC_BASE_URL=https://... \
 *   AIRINGCAL_IMAGE_BASE_URL=https://... (optional; unset keeps images on the public base) \
 *   BANGUMI_GIT_COMMIT_SHA=<40 hex> \
 *   PACKAGE_VERSION=<semver> \
 *   node scripts/materialize-v3-read-staging-config.mjs <source> <output>
 *
 * Every problem (missing value, placeholder URL, shared production bucket) exits 1
 * before Wrangler runs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

const [, , sourcePath, outputPath] = process.argv

if (!sourcePath || !outputPath) {
  console.error('Usage: node scripts/materialize-v3-read-staging-config.mjs <source> <output>')
  process.exit(1)
}

const BUCKET = process.env.AIRINGCAL_STAGING_PUBLIC_R2_BUCKET?.trim() ?? ''
const PUBLIC_BASE_URL = process.env.AIRINGCAL_STAGING_PUBLIC_BASE_URL?.trim() ?? ''
const IMAGE_BASE_URL = process.env.AIRINGCAL_IMAGE_BASE_URL?.trim() ?? ''
const GIT_SHA = process.env.BANGUMI_GIT_COMMIT_SHA?.trim() ?? ''
const PACKAGE_VERSION = process.env.PACKAGE_VERSION?.trim() ?? ''

function fail(message) {
  console.error(`materialize-v3-read-staging-config: ${message}`)
  process.exit(1)
}

/**
 * Shared https/placeholder validation for public base URLs. Returns the
 * parsed URL; every problem exits 1 with the env-var label in the message.
 */
function parseBaseUrl(value, label, placeholderHint) {
  if (/placeholder/i.test(value)) fail(`${label} is a placeholder value; ${placeholderHint}`)
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label} must be an absolute https URL`)
  }
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '') {
    fail(`${label} must be an absolute https URL without query or fragment`)
  }
  return url
}

if (!BUCKET) fail('AIRINGCAL_STAGING_PUBLIC_R2_BUCKET is required')
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(BUCKET)) {
  fail('AIRINGCAL_STAGING_PUBLIC_R2_BUCKET must be a valid R2 bucket name (3-63 lowercase chars)')
}
if (!PUBLIC_BASE_URL) fail('AIRINGCAL_STAGING_PUBLIC_BASE_URL is required')
parseBaseUrl(
  PUBLIC_BASE_URL,
  'AIRINGCAL_STAGING_PUBLIC_BASE_URL',
  'configure the verified staging CDN host',
)
if (IMAGE_BASE_URL) {
  // Image CDN stays OFF by default: unset → the reader reuses the public base.
  parseBaseUrl(
    IMAGE_BASE_URL,
    'AIRINGCAL_IMAGE_BASE_URL',
    'configure a validated image CDN host or unset it to reuse the public base',
  )
}
if (!/^[0-9a-f]{40}$/i.test(GIT_SHA)) fail('BANGUMI_GIT_COMMIT_SHA must be a 40 character git sha')
if (PACKAGE_VERSION && !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(PACKAGE_VERSION)) {
  fail('PACKAGE_VERSION must be a semver version')
}

const source = await readFile(sourcePath, 'utf8')
if (/^\[vars\]$/m.test(source)) fail('source Wrangler config must not declare [vars]; staging vars are injected')
if (/^\[env\./m.test(source)) fail('source Wrangler config must not declare [env.*]; staging config is generated')

const lines = source.split('\n')
const bucketTables = []
let table = ''
let current = null

for (const [index, line] of lines.entries()) {
  const tableMatch = line.match(/^\[\[?([^\]]+)\]\]?$/)
  if (tableMatch) {
    table = tableMatch[1]
    current = table === 'r2_buckets' ? {} : null
    if (current) bucketTables.push(current)
    continue
  }
  if (!current) continue
  const bindingMatch = line.match(/^binding\s*=\s*"([^"]+)"$/)
  if (bindingMatch) {
    current.binding = bindingMatch[1]
    continue
  }
  const bucketMatch = line.match(/^bucket_name\s*=\s*"([^"]+)"$/)
  if (bucketMatch) {
    current.bucketName = bucketMatch[1]
    current.line = index
  }
}

const releaseTable = bucketTables.find((entry) => entry.binding === 'AIRINGCAL_PUBLIC_R2')
if (!releaseTable || releaseTable.line === undefined) {
  fail('source Wrangler config has no AIRINGCAL_PUBLIC_R2 r2_buckets block')
}
if (releaseTable.bucketName === BUCKET) {
  fail(`staging bucket must differ from the production bucket "${releaseTable.bucketName}"; staging never reads production`)
}
lines[releaseTable.line] = `bucket_name = "${BUCKET}"`

const target = resolve(outputPath)
const sourceDir = dirname(resolve(sourcePath))
const targetDir = dirname(target)
const mainLine = lines.findIndex((line) => /^main\s*=\s*"/.test(line))
if (mainLine === -1) fail('source Wrangler config has no main entry')
const mainPath = lines[mainLine].match(/^main\s*=\s*"([^"]+)"$/)?.[1]
if (!mainPath) fail('source Wrangler config main entry is not a string')
const rewrittenMain = relative(targetDir, resolve(sourceDir, mainPath)).split(sep).join('/')
lines[mainLine] = `main = "${rewrittenMain}"`

const vars = [
  '',
  '# Generated staging vars (#147 C8). Do not commit this file.',
  '[vars]',
  `AIRINGCAL_PUBLIC_BASE_URL = ${JSON.stringify(PUBLIC_BASE_URL)}`,
  `BANGUMI_GIT_COMMIT_SHA = ${JSON.stringify(GIT_SHA.toLowerCase())}`,
]
if (PACKAGE_VERSION) vars.push(`PACKAGE_VERSION = ${JSON.stringify(PACKAGE_VERSION)}`)
if (IMAGE_BASE_URL) vars.push(`AIRINGCAL_IMAGE_BASE_URL = ${JSON.stringify(IMAGE_BASE_URL)}`)

await mkdir(targetDir, { recursive: true })
await writeFile(target, `${lines.join('\n').replace(/\s*$/, '')}\n${vars.join('\n')}\n`, 'utf8')
console.error(`materialize-v3-read-staging-config: wrote ${target} (bucket=${BUCKET})`)
