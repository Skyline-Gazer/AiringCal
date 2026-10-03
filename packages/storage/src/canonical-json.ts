function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Cannot canonicalize non-finite number')
    return value
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(canonicalize)

  if (typeof value === 'object') {
    if (!isPlainObject(value)) throw new TypeError('Canonical JSON only supports plain objects')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }

  throw new TypeError(`Cannot canonicalize ${typeof value}`)
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function sha256Canonical(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
