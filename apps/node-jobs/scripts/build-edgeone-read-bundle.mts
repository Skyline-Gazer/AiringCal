import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import esbuild from 'esbuild'
import { cacheJs, renderIndexPage, widgetCss, widgetJs } from '../../../packages/widget/src/index.ts'

/**
 * Builds the EdgeOne deploy directory.
 *
 * Layout follows the EdgeOne Makers runtime contract:
 *   - `edge-functions/[[default]].js` is the catch-all function (NOT `functions/[[path]].js`,
 *     which the platform does not register as a route);
 *   - the widget page and assets are static files, so `/` is served by the filesystem
 *     handler and never costs edge-function CPU;
 *   - the function bundle is self-contained because workspace packages cannot be
 *     resolved by the EdgeOne builder.
 */
const root = resolve(import.meta.dirname, '../../..')
const outdir = resolve(root, 'apps/edgeone-read-worker/dist')
const functionDir = resolve(outdir, 'edge-functions')
const outfile = resolve(functionDir, '[[default]].js')

await rm(outdir, { recursive: true, force: true })
await mkdir(functionDir, { recursive: true })
await mkdir(resolve(outdir, 'src'), { recursive: true })

await esbuild.build({
  absWorkingDir: resolve(root, 'packages/v3-read'),
  entryPoints: [resolve(root, 'apps/edgeone-read-worker/edge-functions/[[default]].js')],
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

let commitSha
try {
  commitSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
} catch {
  commitSha = undefined
}

await writeFile(resolve(outdir, 'index.html'), renderIndexPage({
  build: commitSha ? { commitSha } : undefined,
}))
await writeFile(resolve(outdir, 'src/bangumi.js'), widgetJs)
await writeFile(resolve(outdir, 'src/bangumi.css'), widgetCss)
await writeFile(resolve(outdir, 'src/cache.js'), cacheJs)

console.log(`edgeone deploy dir: ${outdir} (function ${bundled.length} bytes, commit ${commitSha ?? 'unknown'})`)
