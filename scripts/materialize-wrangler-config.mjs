import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

const [, , sourcePath, outputPath] = process.argv

if (!sourcePath || !outputPath) {
  console.error('Usage: node scripts/materialize-wrangler-config.mjs <source> <output>')
  process.exit(1)
}

const namespaceId = process.env.AIRING_CAL_KV_NAMESPACE_ID
const buildVars = {
  BANGUMI_GIT_COMMIT_SHA: process.env.BANGUMI_GIT_COMMIT_SHA,
  BANGUMI_GIT_REPOSITORY_URL: process.env.BANGUMI_GIT_REPOSITORY_URL,
}

const source = await readFile(sourcePath, 'utf8')
const needsNamespaceId = source.includes('<AIRING_CAL_KV_NAMESPACE_ID>')

if (needsNamespaceId && !namespaceId) {
  console.error('AIRING_CAL_KV_NAMESPACE_ID is required')
  process.exit(1)
}

if (needsNamespaceId && !/^[0-9a-f]{32}$/i.test(namespaceId ?? '')) {
  console.error('AIRING_CAL_KV_NAMESPACE_ID must be a 32 character hexadecimal Cloudflare KV namespace id')
  process.exit(1)
}

const target = resolve(outputPath)
const sourceDir = dirname(resolve(sourcePath))
const targetDir = dirname(target)
let config = source
  .replaceAll('<AIRING_CAL_KV_NAMESPACE_ID>', namespaceId ?? '')
  .replace(/^main\s*=\s*"([^"]+)"/m, (_, mainPath) => {
    const rewrittenMain = relative(targetDir, resolve(sourceDir, mainPath)).split(sep).join('/')
    return `main = "${rewrittenMain}"`
  })

function tomlString(value) {
  return JSON.stringify(String(value))
}

const providedBuildVars = Object.entries(buildVars).filter((entry) => entry[1])
if (providedBuildVars.length) {
  const varLines = providedBuildVars.map(([key, value]) => `${key} = ${tomlString(value)}`).join('\n')
  config += `${config.endsWith('\n') ? '' : '\n'}\n[vars]\n${varLines}\n`
}

await mkdir(dirname(target), { recursive: true })
await writeFile(target, config)
