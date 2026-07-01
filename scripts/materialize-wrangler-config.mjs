import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

const [, , sourcePath, outputPath] = process.argv

if (!sourcePath || !outputPath) {
  console.error('Usage: node scripts/materialize-wrangler-config.mjs <source> <output>')
  process.exit(1)
}

const namespaceId = process.env.AIRING_CAL_KV_NAMESPACE_ID

if (!namespaceId) {
  console.error('AIRING_CAL_KV_NAMESPACE_ID is required')
  process.exit(1)
}

if (!/^[0-9a-f]{32}$/i.test(namespaceId)) {
  console.error('AIRING_CAL_KV_NAMESPACE_ID must be a 32 character hexadecimal Cloudflare KV namespace id')
  process.exit(1)
}

const source = await readFile(sourcePath, 'utf8')
const target = resolve(outputPath)
const sourceDir = dirname(resolve(sourcePath))
const targetDir = dirname(target)
const config = source
  .replaceAll('<AIRING_CAL_KV_NAMESPACE_ID>', namespaceId)
  .replace(/^main\s*=\s*"([^"]+)"/m, (_, mainPath) => {
    const rewrittenMain = relative(targetDir, resolve(sourceDir, mainPath)).split(sep).join('/')
    return `main = "${rewrittenMain}"`
  })

await mkdir(dirname(target), { recursive: true })
await writeFile(target, config)
