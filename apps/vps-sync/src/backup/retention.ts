type RestorePoint = {
  baseKey: string
  date: string
  timestamp: string
  keys: { dump: string; manifest: string }
}

function parseBackupKey(key: string): { baseKey: string; date: string; timestamp: string; extension: 'dump' | 'json' } | null {
  const match = /^backups\/postgres\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{8}T\d{9}Z)-([0-9a-f]{40})\.(dump|json)$/.exec(key)
  if (!match) return null

  const [, year, month, day, timestamp, , extension] = match
  if (!year || !month || !day || !timestamp || (extension !== 'dump' && extension !== 'json')) return null

  const date = `${year}-${month}-${day}`
  const isoTimestamp = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`
  const parsedTime = Date.parse(isoTimestamp)
  if (!Number.isFinite(parsedTime)
    || new Date(parsedTime).toISOString().replace(/[-:.]/g, '') !== timestamp
    || timestamp.slice(0, 4) !== year
    || timestamp.slice(4, 6) !== month
    || timestamp.slice(6, 8) !== day) {
    return null
  }

  return { baseKey: key.slice(0, -extension.length - 1), date, timestamp, extension }
}

function latest(points: readonly RestorePoint[]): RestorePoint {
  return [...points].sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.baseKey.localeCompare(a.baseKey))[0]!
}

/** Returns only paired backup-object keys eligible for a separately approved deletion. */
export function selectBackupDeletions(entries: readonly string[] | null): string[] {
  if (entries === null) return []

  const points = new Map<string, RestorePoint>()
  const seen = new Set<string>()
  for (const key of entries) {
    if (typeof key !== 'string' || seen.has(key)) return []
    seen.add(key)
    const parsed = parseBackupKey(key)
    if (!parsed) return []

    let point = points.get(parsed.baseKey)
    if (!point) {
      point = { baseKey: parsed.baseKey, date: parsed.date, timestamp: parsed.timestamp, keys: { dump: '', manifest: '' } }
      points.set(parsed.baseKey, point)
    }
    const slot = parsed.extension === 'dump' ? 'dump' : 'manifest'
    if (point.date !== parsed.date || point.timestamp !== parsed.timestamp || point.keys[slot]) return []
    point.keys[slot] = key
  }

  const completePoints = [...points.values()]
  if (completePoints.some((point) => !point.keys.dump || !point.keys.manifest)) return []

  const dates = [...new Set(completePoints.map((point) => point.date))].sort((a, b) => b.localeCompare(a))
  const dailyDates = new Set(dates.slice(0, 30))
  const retained = new Set<RestorePoint>()

  for (const date of dailyDates) {
    retained.add(latest(completePoints.filter((point) => point.date === date)))
  }

  const olderMonthlyPoints = new Map<string, RestorePoint[]>()
  for (const point of completePoints) {
    if (dailyDates.has(point.date)) continue
    const month = point.date.slice(0, 7)
    const pointsInMonth = olderMonthlyPoints.get(month) ?? []
    pointsInMonth.push(point)
    olderMonthlyPoints.set(month, pointsInMonth)
  }
  for (const pointsInMonth of olderMonthlyPoints.values()) retained.add(latest(pointsInMonth))

  return completePoints
    .filter((point) => !retained.has(point))
    .flatMap((point) => [point.keys.dump, point.keys.manifest])
    .sort()
}
