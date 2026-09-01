import type { RunDependencies, RunRequest, RunResult, RunStatus } from './contracts.ts'
import type { RunFinishInput } from './postgres/repositories.ts'
import { UpstreamFetchError } from './upstream/retry.ts'

export function exitCode(status: RunStatus): number { return status === 'partial' || status === 'failed' ? 1 : 0 }

export function terminalStatus(components: RunFinishInput['components']): RunStatus {
  if (components.publication === 'skipped') return 'skipped'
  if (components.publication !== 'success' && components.publication !== 'no_change') return 'failed'
  if (components.media === 'partial' || components.media === 'failed' || components.backup === 'failed') return 'partial'
  return components.publication === 'no_change' ? 'no_change' : 'success'
}

export async function runOnce(deps: RunDependencies, request: RunRequest): Promise<RunResult> {
  const at = () => new Date(deps.now()).toISOString()
  const startedAt = at()
  const context = { ...request, runId: deps.runId, observedAt: startedAt }
  const result: RunResult = {
    ...request, id: deps.runId, stage: 'lock', status: 'failed', heartbeatAt: startedAt,
    finishedAt: startedAt, counts: {}, stageDurations: {}, sanitizedError: null,
    components: { collection: 'not_attempted', calendar: 'not_attempted', media: 'not_attempted', publication: 'not_attempted', backup: 'not_attempted', notification: 'not_attempted' },
  }
  const counts: Record<string, number> = {}
  const durations: Record<string, number> = {}
  const components = { ...result.components }
  let heartbeatFailed = false
  const persist = async () => {
    const { source: _source, mode: _mode, publication: _publication, ...row } = result
    await deps.authority.finishRun(row)
  }
  const stage = async <T>(name: keyof RunFinishInput['stageDurations'], operation: () => Promise<T>): Promise<T> => {
    result.stage = name
    await deps.authority.heartbeat(deps.runId, name, at())
    const start = deps.now()
    let pending: Promise<void> | undefined
    const timer = setInterval(() => {
      if (!pending) pending = deps.authority.heartbeat(deps.runId, name, at())
        .catch(() => { heartbeatFailed = true })
        .finally(() => { pending = undefined })
    }, 30000)
    try {
      const value = await operation()
      await pending
      return value
    } finally {
      clearInterval(timer)
      await pending
      durations[name] = Math.max(0, deps.now() - start)
    }
  }
  const failure = (error?: unknown) => {
    result.sanitizedError ??= error instanceof UpstreamFetchError
      ? { category: error.category, code: error.code, attemptCount: error.attempt, stage: error.stage }
      : { category: 'runtime', code: 'STAGE_FAILED', attemptCount: 1, stage: result.stage }
  }
  const applyHeartbeatFailure = () => {
    if (!heartbeatFailed) return
    result.sanitizedError ??= { category: 'runtime', code: 'HEARTBEAT_FAILED', attemptCount: 1, stage: result.stage }
    if (result.status === 'success' || result.status === 'no_change') result.status = 'partial'
  }
  let locked = false
  let begun = false
  try {
    locked = await deps.lock.acquire()
    await deps.authority.beginRun({ ...request, id: deps.runId, gitSha: deps.gitSha, stage: 'lock', status: locked ? 'running' : 'skipped', startedAt, heartbeatAt: startedAt })
    begun = true
    if (locked) try {
      const input = await stage('collection', () => deps.fetchComplete(context))
      context.observedAt = input.observedAt
      components.collection = components.calendar = 'success'
      counts.users = input.users.length
      counts.collections = input.users.reduce((sum, user) => sum + user.items.length, 0)
      const committed = await stage('completeState', () => deps.authority.commitCompleteState({ ...input, runId: deps.runId }))
      Object.assign(counts, committed)
      try {
        const media = await stage('media', () => deps.media(context))
        counts.mediaSelected = media.selected; counts.mediaSucceeded = media.succeeded; counts.mediaFailed = media.failed
        components.media = media.failed ? 'partial' : 'success'
      } catch (error) { components.media = 'failed'; failure(error) }
      result.publication = await stage('publication', () => deps.publish(context))
      components.publication = result.publication.status === 'published' ? 'success' : result.publication.status
      if (result.publication.status === 'published' || result.publication.status === 'no_change') {
        const publication = result.publication
        try { await stage('backup', () => deps.backup(context, publication)); components.backup = 'success' }
        catch (error) { components.backup = 'failed'; failure(error) }
      }
    } catch (error) {
      const component = error instanceof UpstreamFetchError && error.stage === 'calendar' ? 'calendar'
        : result.stage === 'completeState' ? 'collection' : result.stage as keyof typeof components
      if (component in components) components[component] = 'failed'
      failure(error)
    }
    result.status = locked ? terminalStatus(components) : 'skipped'
    applyHeartbeatFailure()
    result.counts = counts; result.stageDurations = durations; result.components = components
    result.finishedAt = result.heartbeatAt = at()
    await persist()
    try { await stage('notification', () => deps.notify(structuredClone(result))); components.notification = 'success' }
    catch { components.notification = 'failed' }
    result.stage = 'finished'; result.heartbeatAt = at()
    applyHeartbeatFailure()
    await persist()
    return result
  } catch (error) {
    failure(error)
    result.status = components.publication === 'success' || components.publication === 'no_change' ? 'partial' : 'failed'
    result.finishedAt = result.heartbeatAt = at()
    result.components = components; result.counts = counts; result.stageDurations = durations
    if (begun) { try { await persist() } catch { /* A database outage cannot persist its own terminal state. */ } }
    try { await deps.notify(structuredClone(result)); components.notification = 'success' }
    catch { components.notification = 'failed' }
    return result
  } finally {
    const cleanupFailure = () => {
      result.sanitizedError ??= { category: 'runtime', code: 'CLEANUP_FAILED', attemptCount: 1, stage: 'cleanup' }
      result.status = components.publication === 'success' || components.publication === 'no_change' ? 'partial' : 'failed'
    }
    try { if (locked) await deps.lock.release() } catch { cleanupFailure() }
    finally { try { await deps.close() } catch { cleanupFailure() } }
  }
}
