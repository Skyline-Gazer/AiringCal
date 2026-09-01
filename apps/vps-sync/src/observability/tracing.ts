export type TraceAttributeValue = string | number | boolean
export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>

export interface TraceSpanInput {
  name: string
  attributes: TraceAttributes
  completeAttributes?: () => TraceAttributes
}

export interface TracingPort {
  span<T>(input: TraceSpanInput, operation: () => Promise<T>): Promise<T>
  flush(): Promise<void>
}

export function memoizeOperation<T>(operation: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined
  return () => promise ??= Promise.resolve().then(operation)
}

/**
 * Starts the business operation independently of an optional tracing callback.
 *
 * Tracing SDKs and injected ports are allowed to settle without calling their
 * callback, to call it late, or to call it more than once. Every path receives
 * the same Promise, and tracing rejections are observed without affecting the
 * business result.
 */
export async function runTracedOperationFailOpen<T>(
  operation: () => Promise<T>,
  trace: (callback: () => Promise<T>) => unknown,
): Promise<T> {
  const executeBusiness = memoizeOperation(operation)
  const business = executeBusiness()
  void business.catch(() => undefined)
  try {
    void Promise.resolve(trace(executeBusiness)).catch(() => undefined)
  } catch {
    // Tracing must not change the business operation.
  }
  return business
}

export const noOpTracing: TracingPort = {
  span: async (_input, operation) => operation(),
  flush: async () => undefined,
}
