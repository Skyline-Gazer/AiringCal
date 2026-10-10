import { fail } from './errors.ts'

export interface RunContext {
  readonly owner: string
  readonly signal: AbortSignal
  guard(extraMs?: number): void
}

export function createRunContext(input: {
  runId: string
  deadlineAt: number
}): RunContext {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('RUN_DEADLINE')), Math.max(0, input.deadlineAt - Date.now()))
  timer.unref?.()
  return {
    owner: input.runId,
    signal: controller.signal,
    guard(extraMs = 0) {
      if (controller.signal.aborted) fail('REQUEST_FAILED')
      const remaining = input.deadlineAt - Date.now()
      if (remaining <= extraMs) controller.abort(new Error('RUN_DEADLINE'))
    },
  }
}
