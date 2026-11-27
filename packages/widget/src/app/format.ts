/** Explicit UTC rendering; invalid input is never replaced with the current time. */
export function formatUtcStamp(value: string | undefined | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function shortCommit(sha: string | undefined | null): string | null {
  const value = sha?.trim()
  return value ? value.slice(0, 7) : null
}
