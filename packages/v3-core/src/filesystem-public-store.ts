import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { canonicalJson } from '@airing-cal/storage'
import type { PublicReleasePointer, PublicStore } from './ports.ts'
import {
  PUBLIC_RELEASE_POINTER_KEY,
  bytesEqual,
  parsePublicReleasePointer,
  releasePointersMatch,
} from './public-pointer.ts'

export class FilesystemPublicStore implements PublicStore {
  constructor(readonly rootDir: string) {}

  resolveObjectPath(key: string): string {
    if (key.includes('\0') || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..')) {
      throw new Error(`Unsafe public store object key: ${key}`)
    }
    const root = resolve(this.rootDir)
    const full = resolve(join(root, key))
    if (full !== root && !full.startsWith(`${root}/`)) {
      throw new Error(`Unsafe public store object key: ${key}`)
    }
    return full
  }

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    const path = this.resolveObjectPath(PUBLIC_RELEASE_POINTER_KEY)
    try {
      const raw = await readFile(path, 'utf8')
      return parsePublicReleasePointer(raw)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    const path = this.resolveObjectPath(artifactRef)
    try {
      return await readFile(path)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  async putImmutableObject(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    const path = this.resolveObjectPath(key)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, body, { flag: 'wx' })
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        const existing = await readFile(path)
        if (!bytesEqual(existing, body)) {
          throw new Error(`Immutable object already exists with different bytes: ${key}`)
        }
        return
      }
      throw error
    }
  }

  async commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    const current = await this.getCurrentRelease()
    if (!releasePointersMatch(expected, current)) return 'conflict'

    const path = this.resolveObjectPath(PUBLIC_RELEASE_POINTER_KEY)
    await mkdir(dirname(path), { recursive: true })
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
    await writeFile(tempPath, `${canonicalJson(next)}\n`, 'utf8')
    try {
      await rename(tempPath, path)
    } catch (error) {
      const after = await this.getCurrentRelease()
      if (releasePointersMatch(next, after)) return 'committed'
      return 'conflict'
    }
    return 'committed'
  }
}
