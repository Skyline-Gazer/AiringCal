import type { RunContext, RunDependencies, RunRequest, RunResult, RunStatus } from './contracts.js'
import type { RunFinishInput } from './postgres/repositories.js'
import { UpstreamFetchError } from './upstream/retry.js'

export function exitCode(status: RunStatus): number {
  return status === 'partial' || status === 'failed' ? 1 : 0
}

export function terminalStatus(components: RunFinishInput['components']): RunStatus {
  if (components.publication === 'skipped') return 'skipped'
  if (components.publication !== 'success' && components.publication !== 'no_change') return 'failed'
  if (components.media === 'partial' || components.media === 'failed' || components.backup === 'failed') return 'partial'
  return components.publication === 'no_change' ? 'no_change' : 'success'
}

function safeNow(deps: RunDependencies): number {
  const now = deps.now()
  if (!Number.isFinite(now)) throw new Error('INVALID_CLOCK')
  return now
}

export async function runOnce(deps: RunDependencies, request: RunRequest): Promise<RunResult> {
  const startedAt = new Date(safeNow(deps)).toISOString()
  const context: RunContext = {
    ...request,
    runId: deps.runId,
    observedAt: startedAt,
  }
  const result: RunResult = {
    ...request,
    id: deps.runId,
    gitSha: deps.gitSha,
    stage: 'lock',
    status: 'failed',
    heartbeatAt: startedAt,
    finishedAt: startedAt,
    counts: {},
    stageDurations: {},
    sanitizedError: null,
    components: {
      collection: 'not_attempted',
      calendar: 'not_attempted',
      media: 'not_attempted',
      publication: 'not_attempted',
      backup: 'not_attempted',
      notification: 'not_attempted',
    },
  }
  const counts: Record<string, number> = {}
  const durations: Record<string, number> = {}
  const components = { ...result.components }
  let heartbeatFailed = false
  const persist = async () => deps.authority.finishRun(result)
  const at = () => new Date(safeNow(deps)).toISOString()
  const stage = async <T>(name: keyof RunFinishInput['stageDurations'], operation: () => Promise<T>): Promise<T> => {
    result.stage = name
    await deps.authority.heartbeat(deps.runId, name, at())
    const started = safeNow(deps)
    let pending: Promise<void> | undefined
    const timer = setInterval(() => {
      if (!pending) {
        pending = deps.authority.heartbeat(deps.runId, name, at())
          .catch(() => { heartbeatFailed = true })
          .finally(() => { pending = undefined })
      }
    }, 30_000)
    try {
      const value = await operation()
      await pending
      if (heartbeatFailed) throw new Error('HEARTBEAT_FAILED')
      return value
    } finally {
      clearInterval(timer)
      await pending
      durations[name] = Math.max(0, safeNow(deps) - started)
    }
  }
  const failure = (error: unknown) => {
    if (result.sanitizedError) return
    result.sanitizedError = error instanceof UpstreamFetchError
      ? { category: error.category, code: error.code, attemptCount: error.attempt, stage: error.stage }
      : { category: 'runtime', code: 'STAGE_FAILED', attemptCount: 1, stage: result.stage }
  }
  let locked = false
  try {
    locked = await deps.lock.acquire()
    await deps.authority.beginRun({
      id: deps.runId,
      source: request.source,
      mode: request.mode,
      stage: 'lock',
      status: locked ? 'running' : 'skipped',
      startedAt,
      heartbeatAt: startedAt,
      gitSha: deps.gitSha,
    })
    if (locked) {
      try {
        const input = await stage('collection', () => deps.fetchComplete(context))
        const inputObservedAt = 'observedAt' in input ? input.observedAt : input.observed_at
        if (typeof inputObservedAt === 'number') context.observedAt = new Date(inputObservedAt * 1_000).toISOString()
        else if (typeof inputObservedAt === 'string') context.observedAt = inputObservedAt
        components.collection = components.calendar = 'success'
        counts.users = input.users.length
        counts.collections = input.users.reduce((sum, user) => sum + user.items.length, 0)
        const committed = await stage('completeState', () => deps.authority.commitCompleteState(input))
        if (committed) Object.assign(counts, committed)
        try {
          const media = await stage('media', () => deps.media(context))
          counts.mediaSelected = media.selected
          counts.mediaSucceeded = media.succeeded
          counts.mediaFailed = media.failed
          components.media = media.failed ? 'partial' : 'success'
        } catch (error) {
          components.media = 'failed'
          failure(error)
        }
        result.publication = await stage('publication', () => deps.publish(context))
        components.publication = result.publication.status === 'published' ? 'success' : result.publication.status
        if (result.publication.status === 'published' || result.publication.status === 'no_change') {
          try {
            await stage('backup', () => deps.backup(context, result.publication as Extract<typeof result.publication, { generation: number }>))
            components.backup = 'success'
          } catch (error) {
            components.backup = 'failed'
            failure(error)
          }
        }
      } catch (error) {
        const component = error instanceof UpstreamFetchError && error.stage === 'calendar'
          ? 'calendar'
          : result.stage === 'completeState' ? 'collection' : result.stage as keyof typeof components
        if (component in components) components[component] = 'failed'
        failure(error)
      }
      result.status = terminalStatus(components)
    } else {
      result.status = 'skipped'
    }
    result.counts = counts
    result.stageDurations = durations
    result.components = components
    result.finishedAt = result.heartbeatAt = at()
    await persist()
    try {
      await stage('notification', () => deps.notify(structuredClone(result)))
      components.notification = 'success'
    } catch (error) {
      components.notification = 'failed'
      failure(error)
    }
    result.stage = 'finished'
    result.heartbeatAt = at()
    result.counts = counts
    result.stageDurations = durations
    result.components = components
    await persist()
    return result
  } finally {
    if (locked) await deps.lock.release()
    await deps.close()
  }
}
