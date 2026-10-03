import { BgmPlatformClient } from '@airing-cal/bgm-api'
import { compareAccounts, executeSync, validateSyncRequest, SyncValidationError } from '@airing-cal/domain'
import type { D1DatabaseLike } from '@airing-cal/storage'
import { publicError, sanitizeErrorMessage, syncHeaders } from '@airing-cal/worker-common'

interface SyncEnv { AIRING_CAL_D1: D1DatabaseLike }
const SYNC_OPERATION_PREFIX = 'sync:operation:'
const SYNC_OPERATION_TTL_SECONDS = 60 * 60 * 24

interface SyncOperationLog {
  id: string
  event: 'sync_operation'
  status: 'running' | 'ok' | 'partial' | 'error'
  mode: string
  requested_count: number
  returned_count: number
  ok: number
  errors: number
  duration_ms: number
  at: string
  error: string | null
  items: Array<{
    externalId: string
    title: string
    status: 'ok' | 'error'
    collectionStatus?: { before: string; after: string }
    scoreChange?: { before: number | null; after: number | null }
    episodeChanged?: number
    episodeProgress?: { before: number; after: number; total: number }
    error?: string
  }>
}

function operationLogKey(id: string): string {
  return `${SYNC_OPERATION_PREFIX}${id}`
}

function createOperationId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function isOperationId(id: string): boolean {
  return /^[0-9a-z]+-[0-9a-f]{16}$/i.test(id)
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(init?.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init?.headers as Record<string, string> | undefined),
    },
  })
}

function errorJson(error: unknown, status = 500): Response {
  return publicError(status, status === 400 ? 'INVALID_REQUEST' : 'REQUEST_FAILED', error)
}

function syncErrorResponse(error: unknown): Response {
  if (error instanceof SyntaxError || error instanceof SyncValidationError) {
    return publicError(400, 'INVALID_REQUEST', error)
  }
  if (error instanceof Error && 'status' in error && (error.status === 401 || error.status === 403)) {
    return publicError(error.status, 'AUTHENTICATION_FAILED', error)
  }
  return publicError(500, 'REQUEST_FAILED', error)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function syncOperationHeaders(id: string): Headers {
  const headers = syncHeaders()
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('X-Sync-Operation-Id', id)
  headers.set('X-Sync-Operation-Url', `/api/check/${id}`)
  return headers
}

function createSyncOperationLog(id: string, mode: string, requestedCount: number, results: any[], durationMs: number): SyncOperationLog {
  const ok = results.filter((result) => result.status === 'ok').length
  const errors = results.filter((result) => result.status === 'error').length
  return {
    id,
    event: 'sync_operation',
    status: errors === 0 ? 'ok' : ok === 0 ? 'error' : 'partial',
    mode,
    requested_count: requestedCount,
    returned_count: results.length,
    ok,
    errors,
    duration_ms: durationMs,
    at: new Date().toISOString(),
    error: null,
    items: results.map((result) => ({
      externalId: result.externalId,
      title: result.title,
      status: result.status,
      ...(result.collectionStatus ? { collectionStatus: result.collectionStatus } : {}),
      ...(result.scoreChange ? { scoreChange: result.scoreChange } : {}),
      ...(typeof result.episodeChanged === 'number' ? { episodeChanged: result.episodeChanged } : {}),
      ...(result.episodeProgress ? { episodeProgress: result.episodeProgress } : {}),
      ...(result.error ? { error: result.error } : {}),
    })),
  }
}

function createRunningSyncOperationLog(id: string, mode: string, requestedCount: number): SyncOperationLog {
  return {
    id,
    event: 'sync_operation',
    status: 'running',
    mode,
    requested_count: requestedCount,
    returned_count: 0,
    ok: 0,
    errors: 0,
    duration_ms: 0,
    at: new Date().toISOString(),
    error: null,
    items: [],
  }
}

function createFailedSyncOperationLog(id: string, mode: string, requestedCount: number, durationMs: number, error: unknown): SyncOperationLog {
  return {
    ...createRunningSyncOperationLog(id, mode, requestedCount),
    status: 'error',
    errors: 1,
    duration_ms: durationMs,
    error: error instanceof SyncValidationError ? sanitizeErrorMessage(error.message) : 'Request failed',
  }
}

async function persistSyncOperationLog(env: SyncEnv, log: SyncOperationLog): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await env.AIRING_CAL_D1.prepare('DELETE FROM airingcal_operations WHERE expires_at <= ?').bind(now).run()
  await env.AIRING_CAL_D1.prepare(
    'INSERT INTO airingcal_operations (id, value_json, expires_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at',
  ).bind(operationLogKey(log.id), JSON.stringify(log), now + SYNC_OPERATION_TTL_SECONDS).run()
}

function getPlatformClient(platform: string): BgmPlatformClient {
  if (platform === 'bgm') return new BgmPlatformClient()
  throw new SyncValidationError('Unsupported platform')
}

function requireSyncTokens(body: Record<string, unknown>): void {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyncValidationError('Invalid request body')
  if (typeof body.tokenA !== 'string' || !body.tokenA.trim() || body.tokenA.length > 4096 || typeof body.tokenB !== 'string' || !body.tokenB.trim() || body.tokenB.length > 4096) {
    throw new SyncValidationError('Missing source/target token')
  }
}

async function fetch(request: Request, env: SyncEnv): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname === '/internal/sync/compare' && request.method === 'POST') {
    try {
      const body = await request.json() as any
      requireSyncTokens(body)
      const clientA = getPlatformClient(body.platformA || 'bgm')
      const clientB = getPlatformClient(body.platformB || 'bgm')
      const result = await compareAccounts(clientA, body.tokenA, clientB, body.tokenB)
      for (const account of [result.userA, result.userB]) {
        if (account.error) account.error = 'Upstream collection request failed'
      }
      return json(result, { headers: syncHeaders() })
    } catch (error) {
      return syncErrorResponse(error)
    }
  }

  if (url.pathname === '/internal/sync/apply' && request.method === 'POST') {
    const startedAt = Date.now()
    const operationId = createOperationId()
    let mode = 'unknown'
    let requestedCount = 0
    let operationStarted = false
    try {
      const body = await request.json() as any
      requireSyncTokens(body)
      mode = typeof body.mode === 'string' ? body.mode : 'unknown'
      requestedCount = Array.isArray(body.items)
        ? body.items.length
        : Array.isArray(body.subject_ids) ? body.subject_ids.length : 0
      const clientA = getPlatformClient(body.platformA || 'bgm')
      const clientB = getPlatformClient(body.platformB || 'bgm')
      const syncRequest = { mode: body.mode, from: body.from, to: body.to, items: body.items, subject_ids: body.subject_ids, baseline: body.baseline }
      validateSyncRequest(syncRequest)
      await persistSyncOperationLog(env, createRunningSyncOperationLog(operationId, mode, requestedCount))
      operationStarted = true
      const results = await executeSync(clientA, body.tokenA, clientB, body.tokenB, syncRequest)
      for (const result of results) {
        if (result.error) result.error = sanitizeErrorMessage(result.error).replaceAll(body.tokenA, '[redacted]').replaceAll(body.tokenB, '[redacted]')
      }
      await persistSyncOperationLog(env, createSyncOperationLog(operationId, body.mode, requestedCount || results.length, results, Date.now() - startedAt))
      return json(results, { headers: syncOperationHeaders(operationId) })
    } catch (error) {
      if (operationStarted) {
        try { await persistSyncOperationLog(env, createFailedSyncOperationLog(operationId, mode, requestedCount, Date.now() - startedAt, error)) } catch { /* Return a redacted error if D1 is also unavailable. */ }
      }
      return errorJson(error, error instanceof SyntaxError || error instanceof SyncValidationError ? 400 : 500)
    }
  }

  if (url.pathname.startsWith('/internal/check/') && request.method === 'GET') {
    const id = url.pathname.split('/').pop() ?? ''
    if (!isOperationId(id)) return errorJson(new Error('Invalid operation id'), 400)
    try {
      const row = await env.AIRING_CAL_D1.prepare(
        'SELECT value_json FROM airingcal_operations WHERE id = ? AND expires_at > ?',
      ).bind(operationLogKey(id), Math.floor(Date.now() / 1000)).first<{ value_json: string }>()
      const operation = row ? JSON.parse(row.value_json) as SyncOperationLog : null
      if (!operation) return errorJson(new Error('Operation log not found or expired'), 404)
      if (request.headers.get('accept')?.includes('application/json')) return json({ ok: true, operation }, { headers: syncHeaders() })
      const escaped = escapeHtml(JSON.stringify(operation, null, 2))
      return new Response(`<h1>同步操作日志</h1><pre>${escaped}</pre>`, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        },
      })
    } catch (error) { return errorJson(error) }
  }

  return new Response('Not found', { status: 404 })
}

export default { fetch }
