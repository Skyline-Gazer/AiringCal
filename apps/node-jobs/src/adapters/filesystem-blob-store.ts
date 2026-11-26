import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { R2Store } from './r2-store.ts'
import { bytesEqual } from '@airing-cal/v3-core/public-pointer'

function resolveObjectPath(rootDir: string, key: string): string {
  if (key.includes('\0') || key.startsWith('/') || key.includes('\\') || key.split('/').includes('..')) {
    throw new Error(`Unsafe blob store key: ${key}`)
  }
  const root = resolve(rootDir)
  const full = resolve(join(root, key))
  if (full !== root && !full.startsWith(`${root}/`)) {
    throw new Error(`Unsafe blob store key: ${key}`)
  }
  return full
}

/** Local immutable object store using the same keys as R2 (`images/{hash}/original`). */
export function createFilesystemBlobStore(rootDir: string): R2Store {
  return {
    async put(key, body, _contentType = 'application/octet-stream') {
      const path = resolveObjectPath(rootDir, key)
      await mkdir(dirname(path), { recursive: true })
      try {
        await writeFile(path, body, { flag: 'wx' })
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          const existing = await readFile(path)
          if (!bytesEqual(existing, body)) {
            throw new Error(`Immutable blob already exists with different bytes: ${key}`)
          }
          return
        }
        throw error
      }
    },
    async get(key, maximumBytes = 32 * 1024 * 1024) {
      const path = resolveObjectPath(rootDir, key)
      try {
        const bytes = await readFile(path)
        if (bytes.byteLength > maximumBytes) return null
        return bytes
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return null
        }
        throw error
      }
    },
    async verifiedPut(key, bytes, contentType) {
      await this.put(key, bytes, contentType)
      const readback = await this.get(key, bytes.byteLength + 1)
      if (!readback || !bytesEqual(bytes, readback)) {
        throw new Error(`Blob readback mismatch: ${key}`)
      }
    },
    close() {},
  }
}
