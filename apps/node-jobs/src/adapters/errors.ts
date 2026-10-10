export type JobErrorCode =
  | 'CONFIG_INVALID'
  | 'D1_REQUEST_FAILED'
  | 'D1_RESPONSE_INVALID'
  | 'LEASE_LOST'
  | 'R2_READ_FAILED'
  | 'R2_WRITE_FAILED'
  | 'R2_PRECONDITION_FAILED'
  | 'R2_READBACK_MISMATCH'
  | 'UPSTREAM_UNAVAILABLE'
  | 'REQUEST_FAILED'

export class JobError extends Error {
  readonly code: JobErrorCode
  readonly httpStatus?: number

  constructor(code: JobErrorCode, httpStatus?: number, options?: { cause?: unknown }) {
    super(code, options)
    this.name = 'JobError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export function fail(code: JobErrorCode, httpStatus?: number, options?: { cause?: unknown }): never {
  throw new JobError(code, httpStatus, options)
}

export function isJobError(value: unknown): value is JobError {
  return value instanceof JobError
}
