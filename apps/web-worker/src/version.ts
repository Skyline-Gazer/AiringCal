/** Deploy/build metadata exposed at GET /api/version */

export const WEB_WORKER_PACKAGE = {
  name: '@airing-cal/web-worker',
  version: '1.1.0',
} as const

export interface VersionEnv {
  BANGUMI_GIT_COMMIT_SHA?: string
  BANGUMI_GIT_REPOSITORY_URL?: string
  BANGUMI_BUILD_TIME?: string
}

const FULL_SHA = /^[0-9a-f]{40}$/i

export interface VersionPayload {
  ok: true
  service: 'airing-cal-frontend'
  app: 'web-worker'
  package: {
    name: string
    version: string
  }
  git: {
    commit: string | null
    commit_short: string | null
    repository: string | null
  }
  build: {
    built_at: string | null
  }
}

export function buildVersionPayload(env: VersionEnv): VersionPayload {
  const rawCommit = env.BANGUMI_GIT_COMMIT_SHA?.trim() ?? ''
  const commit = FULL_SHA.test(rawCommit) ? rawCommit.toLowerCase() : null
  const repository = env.BANGUMI_GIT_REPOSITORY_URL?.trim() || null
  const builtAt = env.BANGUMI_BUILD_TIME?.trim() || null
  return {
    ok: true,
    service: 'airing-cal-frontend',
    app: 'web-worker',
    package: { ...WEB_WORKER_PACKAGE },
    git: {
      commit,
      commit_short: commit ? commit.slice(0, 7) : null,
      repository,
    },
    build: {
      built_at: builtAt,
    },
  }
}

export function versionResponse(env: VersionEnv): Response {
  return Response.json(buildVersionPayload(env), {
    headers: {
      'Cache-Control': 'public, max-age=60',
    },
  })
}
