import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readAsset(path) {
  return readFile(resolve(root, path), 'utf8')
}

const [widgetJs, widgetCss, cacheJs] = await Promise.all([
  readAsset('packages/widget/assets/theme/bangumi.js'),
  readAsset('packages/widget/assets/theme/bangumi.css'),
  readAsset('packages/widget/assets/theme/cache.js'),
])

const output = `// Generated from packages/widget/assets/theme/bangumi.{js,css} and cache.js.
// Keep source edits in assets/theme and regenerate this file.

export const generatedWidgetJs = ${JSON.stringify(widgetJs)}

export const generatedWidgetCss = ${JSON.stringify(widgetCss)}

export const generatedCacheJs = ${JSON.stringify(cacheJs)}
`

await writeFile(resolve(root, 'packages/widget/src/generated-assets.ts'), output)
