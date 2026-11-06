import { resolve } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import esbuild from 'esbuild'

/**
 * Bundles the EdgeOne read-gateway template into a self-contained edge function.
 *
 * The template imports workspace packages (`@airing-cal/v3-read/...`), which no
 * EdgeOne build environment can resolve; the deployed artifact must therefore be
 * a single file. EdgeOne edge functions also lack the static `Response.json()`,
 * so the runtime-facing code builds responses explicitly (see v3-read).
 */
const root = resolve(import.meta.dirname, '../../..')
const outdir = resolve(root, 'apps/edgeone-read-worker/dist')
const outfile = resolve(outdir, 'functions/[[path]].js')

await rm(outdir, { recursive: true, force: true })
await mkdir(resolve(outdir, 'functions'), { recursive: true })

await esbuild.build({
  absWorkingDir: resolve(root, 'packages/v3-read'),
  entryPoints: [resolve(root, 'apps/edgeone-read-worker/functions/[[path]].js')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'esnext',
  logLevel: 'warning',
  alias: {
    '@airing-cal/v3-read/edgeone-read-handler': resolve(root, 'packages/v3-read/src/edgeone-read-handler.ts'),
    '@airing-cal/v3-read/read-config': resolve(root, 'packages/v3-read/src/read-config.ts'),
  },
  metafile: true,
})

// Fail the build if a Node-only import slipped in: EdgeOne edge functions are V8 isolates.
const bundled = await (await import('node:fs/promises')).readFile(outfile, 'utf8')
if (/(^|["'])node:/.test(bundled)) {
  throw new Error('EdgeOne bundle must not include node: builtins')
}

await writeFile(resolve(outdir, 'README.md'), [
  '# EdgeOne deploy artifact (generated)',
  '',
  'Produced by `pnpm -F @airing-cal/node-jobs build:edgeone-read`. Deploy with:',
  '',
  '```bash',
  'pnpm -F @airing-cal/node-jobs build:edgeone-read',
  'edgeone makers deploy apps/edgeone-read-worker/dist -n airingcal-edgeone-read',
  '```',
  '',
  'Set the project variable `AIRINGCAL_PUBLIC_BASE_URL` (absolute https) before',
  'deploying; the handler fails closed with 503 INVALID_READ_CONFIG otherwise.',
  '',
].join('\n'))

console.log(`edgeone bundle: ${outfile} (${bundled.length} bytes)`)
