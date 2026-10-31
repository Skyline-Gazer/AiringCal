import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizePublicBaseUrl,
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
