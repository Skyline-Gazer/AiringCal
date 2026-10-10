const backupKey = /^backups\/postgres\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{40})\.(dump|json)$/

type BackupPoint = { stem: string; day: string; month: string; timestamp: string; keys: string[] }

function points(entries: readonly string[]): BackupPoint[] | undefined {
  const result = new Map<string, BackupPoint>()
  for (const key of entries) {
    const match = backupKey.exec(key)
    if (!match) return undefined
    const [, year, month, day, fileStem, extension] = match
    if (fileStem!.slice(0, 10) !== `${year}-${month}-${day}`) return undefined
    const timestamp = fileStem!.slice(0, 24)
    const instant = new Date(`${timestamp.slice(0, 10)}T${timestamp.slice(11, 13)}:${timestamp.slice(14, 16)}:${timestamp.slice(17, 19)}.${timestamp.slice(20, 23)}Z`)
    if (Number.isNaN(instant.getTime()) || instant.toISOString()
      !== `${timestamp.slice(0, 10)}T${timestamp.slice(11, 13)}:${timestamp.slice(14, 16)}:${timestamp.slice(17, 19)}.${timestamp.slice(20, 23)}Z`) return undefined
    const stem = key.slice(0, -extension!.length - 1)
    const point = result.get(stem) ?? { stem, day: `${year}-${month}-${day}`, month: `${year}-${month}`, timestamp: fileStem!, keys: [] }
    if (point.keys.includes(key)) return undefined
    point.keys.push(key)
    result.set(stem, point)
  }
  return [...result.values()].every((point) => point.keys.length === 2 && point.keys.some((key) => key.endsWith('.dump')) && point.keys.some((key) => key.endsWith('.json')))
    ? [...result.values()]
    : undefined
}

/** Returns only complete, grammar-validated backup pairs that may be removed. */
export function selectBackupDeletions(entries: readonly string[]): string[] {
  const parsed = points(entries)
  if (!parsed) return []
  const newestFirst = [...parsed].sort((left, right) => right.timestamp.localeCompare(left.timestamp))
  const daily = new Map<string, BackupPoint>()
  for (const point of newestFirst) if (!daily.has(point.day)) daily.set(point.day, point)
  const retained = new Set([...daily.values()].slice(0, 30).map((point) => point.stem))
  const monthly = new Map<string, BackupPoint>()
  for (const point of newestFirst) if (retained.has(point.stem) && !monthly.has(point.month)) monthly.set(point.month, point)
  for (const point of newestFirst) {
    if (retained.has(point.stem) || monthly.has(point.month)) continue
    monthly.set(point.month, point)
  }
  for (const point of monthly.values()) retained.add(point.stem)
  return parsed.filter((point) => !retained.has(point.stem)).flatMap((point) => point.keys)
}
