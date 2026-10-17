#!/usr/bin/env node
/**
 * Production snapshot sizing probe (#69/#71) — READ-ONLY and ANONYMIZED.
 *
 * Reads the *live* v2 release pointer (KV `public:current`) and the snapshot
 * object it names (R2 `airing-cal-data`), then reports **byte counts only**:
 * compact JSON bytes, gzip bytes, per-section bytes, item counts, and
 * `single_json_viable` against the ADR 0001 guard.
 *
 * No snapshot content is ever printed or stored — this exists to confirm or
 * revisit the single-JSON decision from a real payload without moving private
 * data anywhere. Requires `CLOUDFLARE_API_TOKEN` (Workers KV/R2 read) and
 * `CLOUDFLARE_ACCOUNT_ID` plus the KV namespace id holding `public:current`.
 */
import { gzipSync } from 'node:zlib'

const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const DATA_BUCKET = process.env.AIRING_CAL_DATA_BUCKET || 'airing-cal-data'
const KV_NAMESPACE = process.env.AIRING_CAL_KV_NAMESPACE_ID
const BASE = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4'
const LIMIT_BYTES = 500 * 1024

function log(stage, extra = {}) {
  console.log(JSON.stringify({ status: 'info', stage, ...extra }))
}

function fail(message) {
  console.error(JSON.stringify({ status: 'failed', stage: 'prod_sizing_probe', message }))
  process.exit(1)
}

function authHeaders() {
  return { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
}

function sectionSizes(snapshot) {
  const totals = {}
  for (const key of Object.keys(snapshot)) totals[key] = JSON.stringify(snapshot[key]).length
  const total = Object.values(totals).reduce((sum, size) => sum + size, 0) || 1
  const out = {}
  for (const [key, size] of Object.entries(totals)) {
    out[key] = { bytes: size, percent: Number(((size / total) * 100).toFixed(1)) }
  }
  return out
}

async function run() {
  if (!TOKEN || !ACCOUNT) fail('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required')
  if (!KV_NAMESPACE) fail('AIRING_CAL_KV_NAMESPACE_ID is required (the namespace holding public:current)')

  log('pointer_read')
  const pointerRes = await fetch(
    `${BASE}/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_NAMESPACE}/values/public%3Acurrent`,
    { headers: authHeaders() },
  )
  if (!pointerRes.ok) fail(`KV public:current read failed (${pointerRes.status})`)
  const pointer = JSON.parse(await pointerRes.text())
  if (!pointer || pointer.schema_version !== 1) fail('unexpected public:current pointer shape')
  log('pointer_ok', { generation: pointer.generation })

  log('snapshot_read', { r2Key: pointer.r2_key })
  const objectRes = await fetch(
    `${BASE}/accounts/${ACCOUNT}/r2/buckets/${DATA_BUCKET}/objects/${encodeURIComponent(pointer.r2_key)}`,
    { headers: authHeaders() },
  )
  if (!objectRes.ok) fail(`R2 object read failed (${objectRes.status})`)
  const bytes = new Uint8Array(await objectRes.arrayBuffer())
  const parsed = JSON.parse(new TextDecoder().decode(bytes))

  const compactJson = JSON.stringify(parsed)
  const gzipBytes = gzipSync(compactJson).length
  const collections = Object.values(parsed.collections ?? {}).reduce((sum, bucket) => sum + bucket.length, 0)
  const calendar = (parsed.calendar ?? []).reduce((sum, day) => sum + (day.items?.length ?? 0), 0)

  console.log(JSON.stringify({
    status: 'ok',
    stage: 'prod_sizing_probe',
    generation: pointer.generation,
    compact_bytes: compactJson.length,
    gzip_bytes: gzipBytes,
    sections_kib: sectionSizes(parsed),
    items: { collections, calendar },
    single_json_viable: gzipBytes < LIMIT_BYTES,
    limit_bytes: LIMIT_BYTES,
    note: gzipBytes < LIMIT_BYTES
      ? 'single JSON snapshot is viable for the real payload'
      : 'single JSON may be too large — revisit ADR 0001 split decision',
  }))
}

await run().catch((error) => fail(error instanceof Error ? error.message : 'unknown'))
