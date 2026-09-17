import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { verifyVpsSyncImage } from './verify-vps-sync-image.mjs'

const root = resolve(import.meta.dirname, '..')

test('vps-sync Dockerfile defines production and debug targets', () => {
  const dockerfilePath = resolve(root, 'Dockerfile.vps-sync')
  assert.equal(existsSync(dockerfilePath), true, 'Dockerfile.vps-sync must exist')

  const dockerfile = readFileSync(dockerfilePath, 'utf8')
  assert.match(dockerfile, /FROM\s+node:alpine\s+AS\s+production/i)
  assert.match(dockerfile, /FROM\s+production\s+AS\s+debug/i)
  assert.match(dockerfile, /pnpm\s+-F\s+@airing-cal\/vps-sync\s+build/)
})

test('production target keeps runtime-only image boundaries', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile.vps-sync'), 'utf8')
  const production = dockerfile.split(/FROM\s+node:alpine\s+AS\s+production/i)[1]?.split(/FROM\s+production\s+AS\s+debug/i, 1)[0] ?? ''

  assert.match(production, /USER\s+node/)
  assert.match(production, /ENTRYPOINT\s+\[\s*['"]node['"],\s*['"]dist\/cli\.js['"]\s*\]/)
  assert.match(production, /COPY\s+--from=build\s+\/workspace\/apps\/vps-sync\/dist\/\s+\.\/dist\//)
  assert.match(production, /COPY\s+--from=build\s+\/prod\/node_modules\s+\.\/node_modules/)
  assert.doesNotMatch(production, /COPY\s+--from=runtime-compile\s+\/runtime\/apps\/vps-sync/)
  assert.doesNotMatch(production, /EXPOSE\s+/i)
  for (const forbidden of ['git', 'curl', 'python', 'vim', 'jq', 'bind-tools', 'typescript', 'tsx']) {
    assert.doesNotMatch(production, new RegExp(`\\b${forbidden}\\b`, 'i'), `production must not install ${forbidden}`)
  }
})

test('debug target includes only verified diagnosis packages', () => {
  const dockerfile = readFileSync(resolve(root, 'Dockerfile.vps-sync'), 'utf8')
  const debug = dockerfile.split(/FROM\s+production\s+AS\s+debug/i)[1] ?? ''

  for (const packageName of ['curl', 'bind-tools', 'netcat-openbsd', 'procps-ng', 'iproute2', 'jq']) {
    assert.match(debug, new RegExp(`\\b${packageName}\\b`), `debug should include ${packageName}`)
  }
})

test('static verifier enforces image and package contracts', () => {
  const result = verifyVpsSyncImage({ root })

  assert.equal(result.ok, true, result.errors.join('\n'))
  assert.deepEqual(result.errors, [])
})
