import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function renderGeneratedAssets(widgetJs, widgetCss, cacheJs) {
  return `// Generated from packages/widget/assets/theme/bangumi.{js,css} and cache.js.
// Keep source edits in assets/theme and regenerate this file.

export const generatedWidgetJs = ${JSON.stringify(widgetJs)}

export const generatedWidgetCss = ${JSON.stringify(widgetCss)}

export const generatedCacheJs = ${JSON.stringify(cacheJs)}
`
}

test('legacy widget asset copies are absent', () => {
  assert.equal(existsSync(resolve(root, 'packages/widget/assets/public')), false)
  assert.equal(existsSync(resolve(root, 'packages/widget/assets/theme/v1')), false)
})

test('generated widget assets exactly match the editable theme sources', async () => {
  const [widgetJs, widgetCss, cacheJs, actualGenerated] = await Promise.all([
    readFile(resolve(root, 'packages/widget/assets/theme/bangumi.js'), 'utf8'),
    readFile(resolve(root, 'packages/widget/assets/theme/bangumi.css'), 'utf8'),
    readFile(resolve(root, 'packages/widget/assets/theme/cache.js'), 'utf8'),
    readFile(resolve(root, 'packages/widget/src/generated-assets.ts'), 'utf8'),
  ])

  assert.equal(actualGenerated, renderGeneratedAssets(widgetJs, widgetCss, cacheJs))
})
