import { fail } from '../adapters/errors.ts'
import type { CompleteFetchUser } from '../upstream/fetch.ts'

export interface SyncUserConfig {
  users: CompleteFetchUser[]
  primaryUserId: string
  gitSha: string
}

export function readSyncUserConfig(env: Record<string, string | undefined>): SyncUserConfig {
  let users: CompleteFetchUser[]
  try {
    const parsed = JSON.parse(env.AIRINGCAL_USERS_JSON?.trim() ?? '') as unknown
    if (!Array.isArray(parsed)) fail('CONFIG_INVALID')
    users = parsed.map((entry) => {
      if (!entry || typeof entry !== 'object') fail('CONFIG_INVALID')
      const row = entry as Record<string, unknown>
      const userId = typeof row.userId === 'string' ? row.userId : typeof row.user_id === 'string' ? row.user_id : ''
      const username = typeof row.username === 'string' ? row.username : ''
      if (!userId || !username) fail('CONFIG_INVALID')
      return { userId, username }
    })
  } catch (error) {
    fail('CONFIG_INVALID', undefined, { cause: error })
  }
  const primaryUserId = env.AIRINGCAL_PRIMARY_USER_ID?.trim() ?? ''
  if (!primaryUserId || !users.some((user) => user.userId === primaryUserId)) fail('CONFIG_INVALID')
  const gitSha = env.BANGUMI_GIT_COMMIT_SHA?.trim() ?? env.GIT_SHA?.trim() ?? ''
  if (!/^[0-9a-f]{40}$/.test(gitSha)) fail('CONFIG_INVALID')
  return { users, primaryUserId, gitSha }
}
