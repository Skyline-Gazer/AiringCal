import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InvalidPublicBaseUrlError,
  createPublicBaseUrlValidator,
  normalizePublicBaseUrl,
  parsePublicBaseUrl,
  publicImageObjectKey,
  resolvePublicImageRedirect,
} from './public-image-url.ts'

test('normalizePublicBaseUrl trims and strips trailing slash', () => {
  assert.equal(normalizePublicBaseUrl(undefined), null)
  assert.equal(normalizePublicBaseUrl(''), null)
  assert.equal(normalizePublicBaseUrl('  '), null)
  assert.equal(
    normalizePublicBaseUrl(' https://PLACEHOLDER_PUBLIC_CDN/ '),
    'https://PLACEHOLDER_PUBLIC_CDN',
  )
})

test('publicImageObjectKey matches release layout', () => {
  const hash = 'a'.repeat(64)
  assert.equal(publicImageObjectKey(hash, 'original'), `images/${hash}/original`)
  assert.equal(publicImageObjectKey(hash, 'thumb'), `images/${hash}/thumb.v2.webp`)
})

test('resolvePublicImageRedirect builds absolute CDN URL or null', () => {
  const hash = 'b'.repeat(64)
  assert.equal(resolvePublicImageRedirect(null, hash, 'original'), null)
  assert.equal(
    resolvePublicImageRedirect('https://PLACEHOLDER_PUBLIC_CDN', hash, 'original'),
    `https://PLACEHOLDER_PUBLIC_CDN/images/${hash}/original`,
  )
  assert.equal(
    resolvePublicImageRedirect('https://PLACEHOLDER_PUBLIC_CDN/', hash, 'thumb'),
    `https://PLACEHOLDER_PUBLIC_CDN/images/${hash}/thumb.v2.webp`,
  )
})

test('parsePublicBaseUrl accepts absolute https bases without a trailing slash', () => {
  assert.equal(parsePublicBaseUrl(undefined), null)
  assert.equal(parsePublicBaseUrl('  '), null)
  assert.equal(parsePublicBaseUrl('https://cdn.example.com'), 'https://cdn.example.com')
  assert.equal(parsePublicBaseUrl(' https://cdn.example.com/airingcal/ '), 'https://cdn.example.com/airingcal')
})

test('parsePublicBaseUrl rejects non-https, relative and decorated values', () => {
  for (const value of ['http://cdn.example.com', 'cdn.example.com', 'ftp://cdn.example.com', '//cdn.example.com']) {
    assert.throws(
      () => parsePublicBaseUrl(value),
      InvalidPublicBaseUrlError,
      `must reject ${value}`,
    )
  }
})

test('parsePublicBaseUrl rejects insecure values unless explicitly allowed for local adapters', () => {
  assert.throws(() => parsePublicBaseUrl('http://127.0.0.1:9000'), InvalidPublicBaseUrlError)
  assert.equal(
    parsePublicBaseUrl('http://127.0.0.1:9000', { allowInsecure: true }),
    'http://127.0.0.1:9000',
  )
})

test('parsePublicBaseUrl rejects placeholder and decorated values', () => {
  for (const value of [
    'https://PLACEHOLDER_PUBLIC_CDN',
    'https://placeholder.example.com/',
    'https://cdn.example.com/airingcal?token=x',
    'https://cdn.example.com/airingcal#frag',
  ]) {
    assert.throws(
      () => parsePublicBaseUrl(value),
      InvalidPublicBaseUrlError,
      `must reject ${value}`,
    )
  }
  assert.throws(
    () => parsePublicBaseUrl('https://PLACEHOLDER_PUBLIC_CDN'),
    /placeholder value/i,
  )
})

test('createPublicBaseUrlValidator memoizes results per distinct value', () => {
  const validate = createPublicBaseUrlValidator()
  assert.equal(validate('https://cdn.example.com'), 'https://cdn.example.com')
  assert.equal(validate('https://cdn.example.com'), 'https://cdn.example.com', 'memoized on repeat')
  assert.equal(validate(undefined), null)
  assert.equal(validate(null), null)
  assert.throws(() => validate('https://PLACEHOLDER_PUBLIC_CDN'), InvalidPublicBaseUrlError)
  assert.throws(() => validate('https://PLACEHOLDER_PUBLIC_CDN'), InvalidPublicBaseUrlError, 'invalid values are not cached')
  assert.equal(validate('https://cdn.example.com/v3'), 'https://cdn.example.com/v3', 'recovers after an invalid value')
})
