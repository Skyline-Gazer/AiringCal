import type { PublicReleasePointer, PublicStore } from './ports.ts'

export class MemoryPublicStore implements PublicStore {
  current: PublicReleasePointer | null = null
  objects = new Map<string, Uint8Array>()
  casSupported = true

  async getCurrentRelease(): Promise<PublicReleasePointer | null> {
    return this.current
  }

  async getSnapshotBytes(artifactRef: string): Promise<Uint8Array | null> {
    const value = this.objects.get(artifactRef)
    return value ? new Uint8Array(value) : null
  }

  async putImmutableObject(key: string, body: Uint8Array, _contentType: string): Promise<void> {
    this.objects.set(key, new Uint8Array(body))
  }

  async commitRelease(
    expected: PublicReleasePointer | null,
    next: PublicReleasePointer,
  ): Promise<'committed' | 'conflict' | 'unsupported'> {
    if (!this.casSupported) return 'unsupported'
    const currentHash = this.current?.content_hash ?? null
    const currentGeneration = this.current?.generation ?? null
    const expectedHash = expected?.content_hash ?? null
    const expectedGeneration = expected?.generation ?? null
    if (currentHash !== expectedHash || currentGeneration !== expectedGeneration) {
      return 'conflict'
    }
    this.current = next
    return 'committed'
  }
}
