import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { PublicStore } from '@airing-cal/v3-core'

export function contentTypeForKey(key: string): string {
  if (key.endsWith('.webp')) return 'image/webp'
  if (key.endsWith('.png')) return 'image/png'
  if (key.endsWith('.json')) return 'application/json'
  return 'application/octet-stream'
}

function listFiles(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) listFiles(root, full, out)
    else if (st.isFile()) out.push(full)
  }
}

/** Upload `images/**` under imageRoot into PublicStore (immutable keys). */
export async function mirrorImageRootToPublicStore(
  imageRoot: string,
  publicStore: PublicStore,
): Promise<{ uploaded: number }> {
  const imagesRoot = join(imageRoot, 'images')
  let uploaded = 0
  try {
    if (!statSync(imagesRoot).isDirectory()) return { uploaded: 0 }
  } catch {
    return { uploaded: 0 }
  }
  const files: string[] = []
  listFiles(imagesRoot, imagesRoot, files)
  for (const file of files) {
    const rel = relative(imageRoot, file).split(sep).join('/')
    if (!rel.startsWith('images/')) continue
    const body = new Uint8Array(readFileSync(file))
    await publicStore.putImmutableObject(rel, body, contentTypeForKey(rel))
    uploaded += 1
  }
  return { uploaded }
}
