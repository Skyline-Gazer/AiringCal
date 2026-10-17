import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { imageStatusKey, subjectDetailKey, subjectMetaKey } from '@airing-cal/storage'
import { openBuilderDatabase, SqliteSubjectMediaStore } from '@airing-cal/v3-builder'
import {
  CloudflareKvExportClient,
  KV_BULK_GET_MAX_KEYS,
  LEGACY_KV_KEY_PREFIXES,
} from '../adapters/cloudflare-kv-export.ts'
import { parseLegacyExportArgs, resolveLegacyExportCredentials, runLegacyExport } from './portable-legacy-export.ts'
import { runLegacyStateImport } from './portable-legacy-state-import.ts'

interface FetchCall {
  url: string
  method: string
  authorization: string | null
  body?: string
}

/** Minimal Cloudflare API stub: serves KV list pages and bulk-get values. */
function kvApiStub(pages: Record<string, { keys: string[]; nextCursor?: string }>, values: Record<string, unknown>) {
  const calls: FetchCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    const parsed = new URL(url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.Authorization ?? null,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })

    if (parsed.pathname.endsWith('/keys')) {
      const prefix = parsed.searchParams.get('prefix') ?? ''
      const cursor = parsed.searchParams.get('cursor') ?? 'start'
      const page = pages[`${prefix}@${cursor}`]
      if (!page) throw new Error(`stub: no page for ${prefix}@${cursor}`)
      return Response.json({
        success: true,
        result: page.keys.map((name) => ({ name })),
        result_info: page.nextCursor === undefined ? { count: page.keys.length } : { count: page.keys.length, cursor: page.nextCursor },
      })
    }
    if (parsed.pathname.endsWith('/bulk/get')) {
      const requested = JSON.parse(String(init?.body)) as { keys: string[]; type?: string }
      assert.equal(requested.type, 'json', 'export must request parsed JSON values')
      const result: Record<string, unknown> = {}
      for (const key of requested.keys) {
        if (Object.hasOwn(values, key)) result[key] = values[key]
      }
      return Response.json({ success: true, result: { values: result } })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'airingcal-legacy-export-'))
}

test('KV export client paginates key listing and reads values in bulk', async () => {
  const { fetchImpl, calls } = kvApiStub(
    {
      'subject:detail:@start': { keys: ['subject:detail:10'], nextCursor: 'page-2' },
      'subject:detail:@page-2': { keys: ['subject:detail:11'] },
    },
    {
      'subject:detail:10': { subject: { id: 10 } },
      'subject:detail:11': { subject: { id: 11 } },
    },
  )
  const client = new CloudflareKvExportClient({
    accountId: 'acct',
    namespaceId: 'ns',
    apiToken: 'token',
    fetchImpl,
  })

  const keys = await client.listKeys('subject:detail:')
  assert.deepEqual(keys, ['subject:detail:10', 'subject:detail:11'])
  assert.deepEqual(await client.getValues(keys), {
    'subject:detail:10': { subject: { id: 10 } },
    'subject:detail:11': { subject: { id: 11 } },
  })

  assert.equal(calls.length, 3)
  assert.match(calls[0]!.url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acct\/storage\/kv\/namespaces\/ns\/keys\?/)
  assert.match(calls[0]!.url, /prefix=subject%3Adetail%3A/)
  assert.match(calls[1]!.url, /cursor=page-2/)
  assert.equal(calls[2]!.url, 'https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/bulk/get')
  assert.equal(calls[2]!.method, 'POST')
  for (const call of calls) assert.equal(call.authorization, 'Bearer token')
})

test('KV export client chunks bulk reads at the API limit', async () => {
  const keys = Array.from({ length: KV_BULK_GET_MAX_KEYS + 5 }, (_, index) => `subject:meta:${index + 1}`)
  const { fetchImpl, calls } = kvApiStub({}, Object.fromEntries(keys.map((key) => [key, { index: key }])))
  const client = new CloudflareKvExportClient({
    accountId: 'acct',
    namespaceId: 'ns',
    apiToken: 'token',
    fetchImpl,
  })

  const values = await client.getValues(keys)
  assert.equal(Object.keys(values).length, keys.length)
  assert.equal(calls.length, 2, '105 keys must be read in two bulk requests')
  assert.equal((JSON.parse(calls[0]!.body!) as { keys: string[] }).keys.length, KV_BULK_GET_MAX_KEYS)
  assert.equal((JSON.parse(calls[1]!.body!) as { keys: string[] }).keys.length, 5)
})

test('KV export client reports API failures and repeated cursors', async () => {
  const failing = (async () => Response.json({
    success: false,
    errors: [{ code: 1001, message: 'namespace not found' }],
  }, { status: 403 })) as typeof fetch
  const denied = new CloudflareKvExportClient({ accountId: 'acct', namespaceId: 'ns', apiToken: 'token', fetchImpl: failing })
  await assert.rejects(() => denied.listKeys('subject:detail:'), /namespace not found/)

  const { fetchImpl } = kvApiStub(
    { 'subject:detail:@start': { keys: ['subject:detail:1'], nextCursor: 'loop' }, 'subject:detail:@loop': { keys: [], nextCursor: 'loop' } },
    {},
  )
  const looping = new CloudflareKvExportClient({ accountId: 'acct', namespaceId: 'ns', apiToken: 'token', fetchImpl })
  await assert.rejects(() => looping.listKeys('subject:detail:'), /repeated cursor/)
})

test('legacy export CLI writes the import input shape and skips absent values', async () => {
  const dir = tempDir()
  const outPath = join(dir, 'nested', 'kv-export.json')
  const { fetchImpl } = kvApiStub(
    {
      'subject:detail:@start': { keys: [subjectDetailKey(10)] },
      'subject:meta:@start': { keys: [subjectMetaKey(10)] },
      'image:status:@start': { keys: [imageStatusKey(20)] },
      'subject:refresh:@start': { keys: ['subject:refresh:99'] },
    },
    {
      [subjectDetailKey(10)]: { subject: { id: 10, name: 'A' } },
      [subjectMetaKey(10)]: { checked_at: 1_700_000_100 },
      [imageStatusKey(20)]: { common: { status: 'cached' } },
      // subject:refresh:99 intentionally absent from the bulk-get response
    },
  )

  const result = await runLegacyExport(
    { outPath, allowEmpty: false },
    {
      env: { CLOUDFLARE_ACCOUNT_ID: 'acct', AIRING_CAL_KV_NAMESPACE_ID: 'ns', CLOUDFLARE_API_TOKEN: 'token' },
      fetchImpl,
    },
  )

  const written = JSON.parse(readFileSync(outPath, 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(written).sort(), [subjectDetailKey(10), subjectMetaKey(10), imageStatusKey(20)].sort())
  assert.equal(result.keyCount, 3)
  assert.deepEqual(result.prefixes, {
    'subject:detail:': 1,
    'subject:meta:': 1,
    'image:status:': 1,
    'subject:refresh:': 1,
  }, 'only keys returned by bulk get are written; the missing refresh value is skipped')
})

test('exported KV JSON round-trips through the legacy state import', async () => {
  const dir = tempDir()
  const kvExport: Record<string, unknown> = {
    [subjectDetailKey(10)]: { subject: { id: 10, name: 'A', images: { common: 'https://lain.bgm.tv/1.jpg', large: null } } },
    [subjectMetaKey(10)]: { checked_at: 1_700_000_100, nsfw: true },
    [imageStatusKey(20)]: {
      common: { status: 'cached', hash: 'b'.repeat(64), uri: `/image/${'b'.repeat(64)}`, r2_key: `images/${'b'.repeat(64)}/original` },
      large: { status: 'failed', hash: null, uri: null, r2_key: null },
    },
  }
  const { fetchImpl } = kvApiStub(
    {
      'subject:detail:@start': { keys: [subjectDetailKey(10)] },
      'subject:meta:@start': { keys: [subjectMetaKey(10)] },
      'image:status:@start': { keys: [imageStatusKey(20)] },
      'subject:refresh:@start': { keys: [] },
    },
    kvExport,
  )
  const client = new CloudflareKvExportClient({ accountId: 'acct', namespaceId: 'ns', apiToken: 'token', fetchImpl })
  const exported = await client.exportLegacyEntries()
  assert.equal(exported.keyCount, 3)

  const sqlitePath = join(dir, 'builder.sqlite')
  const imported = await runLegacyStateImport({
    sqlitePath,
    kvExport: exported.entries,
    subjectIds: [10, 20],
  })
  assert.equal(imported.summary.imported, 2)

  const db = openBuilderDatabase(sqlitePath)
  try {
    const store = new SqliteSubjectMediaStore(db)
    assert.equal((await store.getSubjectMediaRow(10))?.nsfw, 1)
    assert.equal((await store.getSubjectMediaRow(20))?.r2_image_common_key, `images/${'b'.repeat(64)}/original`)
  } finally {
    db.close()
  }
})

test('legacy export CLI parses flags and validates credentials', () => {
  assert.deepEqual(parseLegacyExportArgs(['--out', 'kv.json', '--prefix', 'subject:detail:', '--page-limit', '100']), {
    allowEmpty: false,
    outPath: 'kv.json',
    prefixes: ['subject:detail:'],
    pageLimit: 100,
  })
  assert.throws(() => parseLegacyExportArgs(['--out', 'kv.json', '--page-limit', '0x10']), /Invalid page limit/)
  assert.throws(() => parseLegacyExportArgs(['--out', 'kv.json', '--page-limit', '9']), /--page-limit/)
  assert.throws(() => parseLegacyExportArgs(['--out']), /requires a value/)
  assert.throws(() => parseLegacyExportArgs(['--nope']), /Unknown option/)

  assert.deepEqual(
    resolveLegacyExportCredentials({ allowEmpty: false }, {
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      AIRING_CAL_KV_NAMESPACE_ID: 'ns',
      CLOUDFLARE_API_TOKEN: 'token',
    }),
    { accountId: 'acct', namespaceId: 'ns', apiToken: 'token' },
  )
  assert.throws(() => resolveLegacyExportCredentials({ allowEmpty: false }, {}), /CLOUDFLARE_ACCOUNT_ID/)
  assert.deepEqual(
    resolveLegacyExportCredentials(
      { allowEmpty: false, accountId: 'flag', namespaceId: 'flag-ns', apiToken: 'flag-token' },
      {},
    ),
    { accountId: 'flag', namespaceId: 'flag-ns', apiToken: 'flag-token' },
  )
})

test('legacy export defaults to the four migration prefixes', () => {
  assert.deepEqual([...LEGACY_KV_KEY_PREFIXES], [
    'subject:detail:',
    'subject:meta:',
    'image:status:',
    'subject:refresh:',
  ])
})
