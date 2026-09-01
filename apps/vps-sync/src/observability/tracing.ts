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

export const noOpTracing: TracingPort = {
  span: async (_input, operation) => operation(),
  flush: async () => undefined,
}
