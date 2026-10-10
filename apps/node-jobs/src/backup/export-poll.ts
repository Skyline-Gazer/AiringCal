import { fail } from '../adapters/errors.ts'

export type ExportPollResult = { bookmark: string } | { url: string }

export function exportPoll(result: unknown): ExportPollResult {
  if (!result || typeof result !== 'object') fail('D1_EXPORT_FAILED')
  const record = result as Record<string, unknown>
  if (record.success === false || record.status === 'error' || record.error) fail('D1_EXPORT_FAILED')
  if (record.status === 'complete') {
    let url: URL
    try {
      url = new URL(String((record.result as { signed_url?: unknown })?.signed_url))
    } catch {
      fail('D1_EXPORT_INVALID')
    }
    if (url.protocol !== 'https:' || url.username || url.password) fail('D1_EXPORT_INVALID')
    return { url: url.href }
  }
  if (record.status !== undefined) fail('D1_EXPORT_INVALID')
  if (typeof record.at_bookmark !== 'string' || !record.at_bookmark) fail('D1_EXPORT_INVALID')
  return { bookmark: record.at_bookmark }
}
