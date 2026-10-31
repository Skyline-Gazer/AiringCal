import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryObjectStore } from './memory-object-store.ts'

test('MemoryObjectStore put/get/head round-trip with etag', async () => {
  const store = new MemoryObjectStore()
  const body = new TextEncoder().encode('hello')
  await store.put('a.bin', body, { contentType: 'application/octet-stream' })
  const head = await store.head('a.bin')
  assert.ok(head?.etag)
  const got = await store.get('a.bin')
  assert.ok(got)
  assert.equal(got.etag, head.etag)
  assert.deepEqual(got.body, body)
})

test('MemoryObjectStore If-None-Match * refuses overwrite', async () => {
  const store = new MemoryObjectStore()
  const body = new TextEncoder().encode('one')
  await store.put('k', body, { ifNoneMatch: '*' })
  await assert.rejects(
    () => store.put('k', new TextEncoder().encode('two'), { ifNoneMatch: '*' }),
    /precondition/i,
  )
})

test('MemoryObjectStore If-Match enforces etag', async () => {
  const store = new MemoryObjectStore()
  await store.put('k', new TextEncoder().encode('one'))
  const head = await store.head('k')
  assert.ok(head)
  await assert.rejects(
    () => store.put('k', new TextEncoder().encode('two'), { ifMatch: '"wrong"' }),
    /precondition/i,
  )
  await store.put('k', new TextEncoder().encode('two'), { ifMatch: head.etag })
  const got = await store.get('k')
  assert.equal(new TextDecoder().decode(got!.body), 'two')
})
