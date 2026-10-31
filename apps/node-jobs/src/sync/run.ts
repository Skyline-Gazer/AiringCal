import type { JobSummary } from '../contracts.ts'
import { runPortableBuilderSync } from './run-portable.ts'

/** ADR 0003: only portable write path remains. */
export function resolveSyncBuilderKind(
  env: Record<string, string | undefined>,
): 'portable' | 'rejected' {
  const raw = env.AIRINGCAL_BUILDER?.trim().toLowerCase() ?? 'portable'
  if (raw === 'legacy' || raw === 'legacy-d1' || raw === 'cloudflare') return 'rejected'
  return 'portable'
}

/** Portable sync entry (ADR 0003). D1/KV QingLong write path removed. */
export async function runSync(env: Record<string, string | undefined> = process.env): Promise<JobSummary> {
  if (resolveSyncBuilderKind(env) === 'rejected') {
    return {
      job: 'airingcal-sync',
      status: 'failed',
      message:
        'AIRINGCAL_BUILDER=legacy-d1 (D1/KV write) is retired (ADR 0003); use portable + GitHub Actions writer',
    }
  }
  return runPortableBuilderSync(env)
}
