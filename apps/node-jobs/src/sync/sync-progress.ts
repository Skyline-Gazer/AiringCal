export function progressBar(pct: number, width = 20): string {
  const clamped = Math.min(100, Math.max(0, pct))
  const filled = Math.min(width, Math.round((width * clamped) / 100))
  return `${'#'.repeat(filled)}${'·'.repeat(width - filled)}`
}

export function emitProgress(
  label: string,
  stage: string,
  done: number,
  total: number,
  extra: Record<string, unknown> = {},
): void {
  if (total <= 0) return
  const pct = (done / total) * 100
  const bar = progressBar(pct)
  const suffix = Object.entries(extra)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  console.log(`${label}  [${bar}]  ${pct.toFixed(1)}%  ${done}/${total}${suffix ? `  ${suffix}` : ''}`)
  console.log(JSON.stringify({
    status: 'info',
    stage,
    done,
    total,
    pct: Math.round(pct * 10) / 10,
    ...extra,
  }))
}

export function emitStage(message: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ status: 'info', ...fields, message }))
}
