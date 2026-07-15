export const packageBoundary = '@airing-cal/worker-common'

const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
  BGM_AUTH: 'Authentication failed',
  BGM_UPSTREAM: 'Upstream request failed',
  BGM_TIMEOUT: 'Upstream request timed out',
  AUTHENTICATION_FAILED: 'Authentication failed',
  INVALID_REQUEST: 'Invalid request',
  REQUEST_FAILED: 'Request failed',
}

export function sanitizeErrorMessage(message: unknown): string {
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(access_token|refresh_token|client_secret|cron_secret)=([^&\s]+)/gi, '$1=[redacted]')
}

export function syncHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
  })
}

export function publicError(status: number, code: string, _error?: unknown): Response {
  const headers = syncHeaders()
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return Response.json({
    ok: false,
    error: {
      code,
      message: PUBLIC_ERROR_MESSAGES[code] ?? 'Request failed',
    },
  }, { status, headers })
}
