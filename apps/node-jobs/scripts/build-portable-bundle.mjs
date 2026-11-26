import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'dist/portable-bundle')

const entries = [
  ['airingcal-sync.mjs', 'src/cli/sync-main.ts'],
  ['gha-portable-writer.mjs', 'src/cli/gha-portable-writer-main.ts'],
]

await mkdir(outdir, { recursive: true })

for (const [outfile, entry] of entries) {
  await esbuild.build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(outdir, outfile),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    external: ['@aws-sdk/client-s3', 'sharp', 'node:sqlite'],
    logLevel: 'info',
  })
}

await writeFile(
  resolve(outdir, 'manifest.json'),
  `${JSON.stringify({
    generated_at: new Date().toISOString(),
    contract: 'ADR 0003 portable writer bundle',
    entries: entries.map(([name]) => name),
  }, null, 2)}\n`,
)
