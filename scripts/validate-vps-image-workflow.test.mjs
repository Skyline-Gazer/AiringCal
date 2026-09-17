import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { validateVpsImageWorkflow } from './validate-vps-image-workflow.mjs'

const workflowPath = new URL('../.github/workflows/vps-sync-image.yml', import.meta.url)

function workflow() {
  return readFileSync(workflowPath, 'utf8')
}

function assertInvalid(source, expected) {
  const result = validateVpsImageWorkflow({ text: source })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes(expected)), result.errors.join('\n'))
}

test('accepts the checked-in production image workflow', () => {
  const result = validateVpsImageWorkflow({ text: workflow() })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

test('requires all verification gates to precede the registry push', () => {
  const source = workflow().replace('      - name: Build check\n        run: pnpm build:check\n', '')
  assertInvalid(source, 'pnpm build:check')
})

test('requires an exact full Git SHA tag and a separate discovery tag', () => {
  assertInvalid(workflow().replace('type=raw,value=${{ github.sha }}', 'type=sha'), 'full SHA')
  assertInvalid(workflow().replace('type=raw,value=latest,enable={{is_default_branch}}', 'type=sha,format=long'), 'discovery')
})

test('rejects mutable action tags and unverified action SHAs', () => {
  assertInvalid(workflow().replace('actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09', 'actions/checkout@v5'), 'commit SHA')
  assertInvalid(workflow().replace('docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8', 'docker/build-push-action@' + '0'.repeat(40)), 'verified')
})

test('uses the verified pnpm action v4 commit', () => {
  const result = validateVpsImageWorkflow({
    text: workflow().replace(
      'pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa',
      'pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda',
    ),
  })
  assert.equal(result.ok, true, result.errors.join('\n'))
})

test('requires GHCR permissions, concurrency, metadata, and non-overwrite guard', () => {
  assertInvalid(workflow().replace('      packages: write\n', ''), 'packages: write')
  assertInvalid(workflow().replace('concurrency:\n  group: vps-sync-image-${{ github.ref }}\n  cancel-in-progress: false\n', ''), 'concurrency')
  assertInvalid(workflow().replace('overwrite: false', 'overwrite: true'), 'overwrite')
  assertInvalid(workflow().replace('https://${REGISTRY}/v2/${repository}/manifests/${GITHUB_SHA}', 'https://${REGISTRY}/v2/${repository}/manifests/latest'), 'full-SHA preflight')
})

test('rejects VPS credentials, SSH, and debug-image behavior', () => {
  assertInvalid(workflow() + '\n      DATABASE_URL: ${{ secrets.DATABASE_URL }}\n', 'VPS secret')
  assertInvalid(workflow() + '\n      ssh: default\n', 'SSH')
  assertInvalid(workflow().replace('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:'), 'workflow_dispatch')
  assertInvalid(workflow() + '\n      target: debug\n', 'debug')
})

test('fails closed when the setup-node major no longer matches node:alpine metadata', () => {
  assertInvalid(workflow().replace("NODE_MAJOR: '26'", "NODE_MAJOR: '24'"), 'Node major')
  assertInvalid(workflow().replace('node-version: 26', 'node-version: 24'), 'Node major')
  assertInvalid(workflow().replace('docker-library/official-images/master/library/node', 'example.invalid/node'), 'official node metadata')
})
