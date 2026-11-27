import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fetchReleaseTag, readPackageAt, upgradeWorkspace } from './update-plan.mjs'

// Real git, real remotes: the unit tests pin command strings, this proves the
// commands actually upgrade a workspace and refuse unsafe states.
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Update Test',
  GIT_AUTHOR_EMAIL: 'update@example.com',
  GIT_COMMITTER_NAME: 'Update Test',
  GIT_COMMITTER_EMAIL: 'update@example.com',
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim()
}

test('upgradeWorkspace upgrades a clean clone to the published tag and never destroys local state', () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-update-'))
  try {
    git(root, ['init', '--bare', '-q', 'origin.git'])
    const seeder = join(root, 'seeder')
    git(root, ['clone', '-q', 'origin.git', 'seeder'])
    writeFileSync(join(seeder, 'package.json'), JSON.stringify({ name: 'airingcal', version: '9.9.9' }))
    git(seeder, ['add', '.'])
    git(seeder, ['commit', '-q', '-m', 'release'])
    git(seeder, ['tag', 'v9.9.9'])
    git(seeder, ['push', '-q', 'origin', 'HEAD', 'refs/tags/v9.9.9'])
    const released = git(seeder, ['rev-parse', 'HEAD'])

    writeFileSync(join(seeder, 'README.md'), 'after the release\n')
    git(seeder, ['add', '.'])
    git(seeder, ['commit', '-q', '-m', 'after release'])
    git(seeder, ['push', '-q', 'origin', 'HEAD'])
    const ahead = git(seeder, ['rev-parse', 'HEAD'])

    const work = join(root, 'work')
    git(root, ['clone', '-q', 'origin.git', 'work'])
    git(work, ['tag', '-d', 'v9.9.9'])
    const result = upgradeWorkspace({ targetTag: 'v9.9.9', targetSha: released, cwd: work, log: () => {} })
    assert.equal(result.ok, true)
    assert.equal(result.previousHead, ahead)
    assert.equal(result.headSha, released)
    assert.equal(git(work, ['rev-parse', 'HEAD']), released)
    assert.equal(readPackageAt({ sha: released, cwd: work }).version, '9.9.9')

    writeFileSync(join(work, 'uncommitted.txt'), 'local work\n')
    const dirty = upgradeWorkspace({ targetTag: 'v9.9.9', targetSha: released, cwd: work })
    assert.equal(dirty.code, 'UPDATE_WORKSPACE_DIRTY')
    assert.equal(git(work, ['rev-parse', 'HEAD']), released, 'a refused update must not move HEAD')

    git(work, ['tag', '-f', 'v9.9.9', ahead])
    const conflict = upgradeWorkspace({ targetTag: 'v9.9.9', targetSha: released, cwd: work })
    assert.equal(conflict.code, 'UPDATE_WORKSPACE_DIRTY', 'dirty tree is reported before tag conflicts')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('fetchReleaseTag refuses to retag a conflicting local commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'airingcal-tag-'))
  try {
    git(root, ['init', '--bare', '-q', 'origin.git'])
    const work = join(root, 'work')
    git(root, ['clone', '-q', 'origin.git', 'work'])
    writeFileSync(join(work, 'a.txt'), 'a\n')
    git(work, ['add', '.'])
    git(work, ['commit', '-q', '-m', 'a'])
    const local = git(work, ['rev-parse', 'HEAD'])
    git(work, ['tag', 'v1.0.0'])

    const refused = fetchReleaseTag({ tag: 'v1.0.0', sha: 'f'.repeat(40), cwd: work })
    assert.equal(refused.code, 'UPDATE_TAG_CONFLICT')
    assert.equal(git(work, ['rev-parse', 'v1.0.0^{commit}']), local, 'the local tag keeps pointing at its commit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})