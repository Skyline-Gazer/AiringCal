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

export const noOpTracing: TracingPort = {
  span: async (_input, operation) => operation(),
  flush: async () => undefined,
}
