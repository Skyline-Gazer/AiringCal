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

function safeFailure(stage: string): NonNullable<RunResult['sanitizedError']> {
  return { category: 'runtime', code: 'STAGE_FAILED', attemptCount: 1, stage }
}

export async function runOnce(deps: RunDependencies, request: RunRequest): Promise<RunResult> {
  const fallbackNow = Date.now()
  let clockFailed = false
  const safeNow = (): number => {
    try {
      const now = deps.now()
      if (Number.isFinite(now) && !Number.isNaN(new Date(now).getTime())) return now
    } catch { /* map the clock boundary to a stable run error */ }
    clockFailed = true
    return fallbackNow
  }
  const startedAt = new Date(safeNow()).toISOString()
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
    notificationFailure: null,
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
  let boundaryFailed = clockFailed
  const boundaryFailure = (stage: string) => {
    boundaryFailed = true
    if (!result.sanitizedError) result.sanitizedError = safeFailure(stage)
  }
  const at = () => new Date(safeNow()).toISOString()
  const syncResult = () => {
    result.counts = counts
    result.stageDurations = durations
    result.components = components
  }
  const persist = async () => {
    try {
      await deps.authority.finishRun(result)
    } catch {
      boundaryFailure('finished')
    }
  }
  const stage = async <T>(
    name: keyof RunFinishInput['stageDurations'],
    operation: () => Promise<T>,
    options: { continueOnHeartbeatFailure?: boolean; onHeartbeatFailure?: () => void } = {},
  ): Promise<T> => {
    result.stage = name
    let heartbeatFailed = false
    const markHeartbeatFailure = () => {
      heartbeatFailed = true
      try { options.onHeartbeatFailure?.() } catch { /* callback cannot cross the stage boundary */ }
    }
    const heartbeat = () => Promise.resolve().then(() => deps.authority.heartbeat(deps.runId, name, at()))
    try {
      await heartbeat()
    } catch {
      markHeartbeatFailure()
      if (!options.continueOnHeartbeatFailure) throw new Error('HEARTBEAT_FAILED')
    }
    const started = safeNow()
    let pending: Promise<void> | undefined
    const timer = setInterval(() => {
      if (!pending) {
        pending = heartbeat()
          .catch(() => { markHeartbeatFailure() })
          .finally(() => { pending = undefined })
      }
    }, 30_000)
    try {
      const value = await operation()
      await pending
      if (heartbeatFailed && !options.continueOnHeartbeatFailure) throw new Error('HEARTBEAT_FAILED')
      return value
    } finally {
      clearInterval(timer)
      await pending
      durations[name] = Math.max(0, safeNow() - started)
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
    let acquireFailed = false
    if (clockFailed) {
      acquireFailed = true
      boundaryFailure('lock')
    } else {
      try {
        locked = await deps.lock.acquire()
      } catch {
        acquireFailed = true
        boundaryFailure('lock')
      }
    }
    let began = false
    if (!acquireFailed) {
      try {
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
        began = true
      } catch {
        boundaryFailure('lock')
      }
    }
    if (acquireFailed || !began) {
      result.status = 'failed'
    } else if (locked) {
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
  } catch {
    boundaryFailure(result.stage)
    result.status = 'failed'
  }

  syncResult()
  if (clockFailed || boundaryFailed) boundaryFailure(result.stage)
  const finishedAt = at()
  if (clockFailed) boundaryFailure(result.stage)
  result.finishedAt = result.heartbeatAt = finishedAt
  syncResult()
  await persist()

  try {
    const previous = await deps.authority.getPreviousNotificationFailure?.(deps.runId)
    result.previousNotificationFailure = previous
      && previous.category === 'notification'
      && previous.code === 'NOTIFICATION_FAILED'
      && previous.stage === 'notification'
      && Number.isSafeInteger(previous.attemptCount)
      && previous.attemptCount >= 1
      && previous.attemptCount <= 3
      ? { category: 'notification', code: 'NOTIFICATION_FAILED', stage: 'notification', attemptCount: previous.attemptCount }
      : null
  } catch {
    result.previousNotificationFailure = null
    boundaryFailure('notification')
  }

  let notificationHeartbeatFailed = false
  let delivered: 'sent' | 'failed' = 'failed'
  try {
    const outcome = await stage('notification', () => deps.notify(structuredClone(result)), {
      continueOnHeartbeatFailure: true,
      onHeartbeatFailure: () => {
        notificationHeartbeatFailed = true
        boundaryFailure('notification')
      },
    })
    delivered = outcome === 'failed' ? 'failed' : 'sent'
  } catch {
    boundaryFailure('notification')
  }
  const notificationFailed = notificationHeartbeatFailed || delivered === 'failed'
  components.notification = notificationFailed ? 'failed' : 'success'
  result.notificationFailure = notificationFailed
    ? { category: 'notification', code: 'NOTIFICATION_FAILED', stage: 'notification', attemptCount: 1 }
    : null
  result.stage = 'finished'
  const terminalHeartbeatAt = at()
  if (clockFailed) boundaryFailure('finished')
  result.heartbeatAt = terminalHeartbeatAt
  syncResult()
  await persist()

  try {
    if (locked) await deps.lock.release()
  } catch {
    boundaryFailure('finished')
  }
  try {
    await deps.close()
  } catch {
    boundaryFailure('finished')
  }
  return result
}
