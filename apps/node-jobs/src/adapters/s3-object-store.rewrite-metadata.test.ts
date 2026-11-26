import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ObjectStorePreconditionError } from './object-store.ts'
import { createS3ObjectStore } from './s3-object-store.ts'

const CONFIG = {
  endpoint: 'https://s3.mock.local',
  region: 'auto',
  bucket: 'airingcal-staging-public',
  accessKeyId: 'test-key',
  secretAccessKey: 'test-secret',
}

const KEY = 'images/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/original'
const BODY = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const BODY_SHA256 = createHash('sha256').update(BODY).digest('hex')
const OLD_ETAG = '"etag-old"'
const NEW_ETAG = '"etag-new"'

type Sent = { name: string; input: Record<string, unknown> }

function commandName(command: unknown): string {
  return (command as { constructor?: { name?: string } }).constructor?.name ?? 'Unknown'
}

function makeBody(bytes: Uint8Array) {
  return {
    transformToByteArray: async () => bytes,
  }
}

test('rewriteMetadata CopyObject path: merges user metadata, updates Content-Type, body hash stable', async () => {
  const sent: Sent[] = []
  const client = {
    async send(command: unknown) {
      const name = commandName(command)
      const input = { ...(command as { input: Record<string, unknown> }).input }
      sent.push({ name, input })
      if (name === 'HeadObjectCommand') {
        return {
          ETag: OLD_ETAG,
          ContentType: 'application/octet-stream',
          ContentLength: BODY.byteLength,
          Metadata: { keep: 'yes', vendor: 'r2' },
        }
      }
      if (name === 'GetObjectCommand') {
        const afterCopy = sent.some((s) => s.name === 'CopyObjectCommand')
        return {
          Body: makeBody(BODY),
          ETag: afterCopy ? NEW_ETAG : OLD_ETAG,
          ContentType: afterCopy ? 'image/jpeg' : 'application/octet-stream',
        }
      }
      if (name === 'CopyObjectCommand') {
        return { CopyObjectResult: { ETag: NEW_ETAG }, ETag: NEW_ETAG }
      }
      throw new Error(`unexpected command ${name}`)
    },
    destroy() {},
  }

  const store = createS3ObjectStore(CONFIG, { client })
  const head = await store.rewriteMetadata!(KEY, {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable',
    contentDisposition: 'inline',
    expectedEtag: OLD_ETAG,
  })

  assert.equal(head.contentType, 'image/jpeg')
  assert.equal(head.etag, NEW_ETAG)
  assert.notEqual(head.etag, OLD_ETAG)

  const copy = sent.find((s) => s.name === 'CopyObjectCommand')
  assert.ok(copy)
  assert.equal(copy.input.MetadataDirective, 'REPLACE')
  assert.equal(copy.input.ContentType, 'image/jpeg')
  assert.equal(copy.input.CacheControl, 'public, max-age=31536000, immutable')
  assert.equal(copy.input.ContentDisposition, 'inline')
  assert.equal(copy.input.CopySourceIfMatch, OLD_ETAG)
  assert.deepEqual(copy.input.Metadata, { keep: 'yes', vendor: 'r2' })
  assert.ok(String(copy.input.CopySource).includes(KEY))

  const gets = sent.filter((s) => s.name === 'GetObjectCommand')
  assert.ok(gets.length >= 2, 'must GET before and after for hash verify')
  assert.equal(BODY_SHA256, createHash('sha256').update(BODY).digest('hex'))
  assert.equal(sent.some((s) => s.name === 'PutObjectCommand'), false)
})

test('rewriteMetadata CopySourceIfMatch failure → ObjectStorePreconditionError', async () => {
  const client = {
    async send(command: unknown) {
      const name = commandName(command)
      if (name === 'HeadObjectCommand') {
        return {
          ETag: OLD_ETAG,
          ContentType: 'application/octet-stream',
          ContentLength: BODY.byteLength,
          Metadata: { keep: 'yes' },
        }
      }
      if (name === 'GetObjectCommand') {
        return {
          Body: makeBody(BODY),
          ETag: OLD_ETAG,
          ContentType: 'application/octet-stream',
        }
      }
      if (name === 'CopyObjectCommand') {
        const err = new Error('Precondition Failed')
        ;(err as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata = {
          httpStatusCode: 412,
        }
        ;(err as { name?: string }).name = 'PreconditionFailed'
        throw err
      }
      throw new Error(`unexpected command ${name}`)
    },
    destroy() {},
  }

  const store = createS3ObjectStore(CONFIG, { client })
  await assert.rejects(
    () =>
      store.rewriteMetadata!(KEY, {
        contentType: 'image/jpeg',
        expectedEtag: OLD_ETAG,
      }),
    ObjectStorePreconditionError,
  )
})

test('rewriteMetadata falls back to Get+Put with IfMatch when CopyObject unsupported', async () => {
  const sent: Sent[] = []
  let copyAttempts = 0
  const client = {
    async send(command: unknown) {
      const name = commandName(command)
      const input = { ...(command as { input: Record<string, unknown> }).input }
      sent.push({ name, input })
      if (name === 'HeadObjectCommand') {
        return {
          ETag: OLD_ETAG,
          ContentType: 'application/octet-stream',
          ContentLength: BODY.byteLength,
          Metadata: { keep: 'yes' },
        }
      }
      if (name === 'GetObjectCommand') {
        const afterPut = sent.some((s) => s.name === 'PutObjectCommand')
        return {
          Body: makeBody(BODY),
          ETag: afterPut ? NEW_ETAG : OLD_ETAG,
          ContentType: afterPut ? 'image/png' : 'application/octet-stream',
        }
      }
      if (name === 'CopyObjectCommand') {
        copyAttempts++
        const err = new Error('Not Implemented')
        ;(err as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata = {
          httpStatusCode: 501,
        }
        ;(err as { name?: string }).name = 'NotImplemented'
        throw err
      }
      if (name === 'PutObjectCommand') {
        return { ETag: NEW_ETAG }
      }
      throw new Error(`unexpected command ${name}`)
    },
    destroy() {},
  }

  const store = createS3ObjectStore(CONFIG, { client })
  const head = await store.rewriteMetadata!(KEY, {
    contentType: 'image/png',
    cacheControl: 'public, max-age=31536000, immutable',
    contentDisposition: 'inline',
    expectedEtag: OLD_ETAG,
  })

  assert.equal(copyAttempts, 1)
  assert.equal(head.contentType, 'image/png')
  assert.equal(head.etag, NEW_ETAG)

  const put = sent.find((s) => s.name === 'PutObjectCommand')
  assert.ok(put)
  assert.equal(put.input.ContentType, 'image/png')
  assert.equal(put.input.CacheControl, 'public, max-age=31536000, immutable')
  assert.equal(put.input.ContentDisposition, 'inline')
  assert.equal(put.input.IfMatch, OLD_ETAG)
  assert.deepEqual(put.input.Metadata, { keep: 'yes' })
  assert.ok(put.input.Body instanceof Uint8Array)
  assert.equal(
    createHash('sha256').update(put.input.Body as Uint8Array).digest('hex'),
    BODY_SHA256,
  )
})

test('rewriteMetadata preserveUserMetadata=false does not forward prior Metadata', async () => {
  const sent: Sent[] = []
  const client = {
    async send(command: unknown) {
      const name = commandName(command)
      const input = { ...(command as { input: Record<string, unknown> }).input }
      sent.push({ name, input })
      if (name === 'HeadObjectCommand') {
        return {
          ETag: OLD_ETAG,
          ContentType: 'application/octet-stream',
          Metadata: { drop: 'me' },
        }
      }
      if (name === 'GetObjectCommand') {
        const afterCopy = sent.some((s) => s.name === 'CopyObjectCommand')
        return {
          Body: makeBody(BODY),
          ETag: afterCopy ? NEW_ETAG : OLD_ETAG,
          ContentType: afterCopy ? 'image/jpeg' : 'application/octet-stream',
        }
      }
      if (name === 'CopyObjectCommand') {
        return { CopyObjectResult: { ETag: NEW_ETAG }, ETag: NEW_ETAG }
      }
      throw new Error(`unexpected command ${name}`)
    },
    destroy() {},
  }

  const store = createS3ObjectStore(CONFIG, { client })
  await store.rewriteMetadata!(KEY, {
    contentType: 'image/jpeg',
    expectedEtag: OLD_ETAG,
    preserveUserMetadata: false,
  })

  const copy = sent.find((s) => s.name === 'CopyObjectCommand')
  assert.ok(copy)
  assert.equal(copy.input.Metadata, undefined)
})

