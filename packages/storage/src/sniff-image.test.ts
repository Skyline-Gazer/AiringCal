import assert from 'node:assert/strict'
import test from 'node:test'
import { sniffImage } from './sniff-image.ts'

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values)
}

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0))
}

test('sniffImage detects jpeg magic', () => {
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg')
})

test('sniffImage detects png magic', () => {
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png')
})

test('sniffImage detects gif magic', () => {
  assert.equal(sniffImage(bytes(...ascii('GIF89a'))), 'image/gif')
})

test('sniffImage detects webp magic', () => {
  assert.equal(
    sniffImage(bytes(...ascii('RIFF'), 0x00, 0x00, 0x00, 0x00, ...ascii('WEBP'))),
    'image/webp',
  )
})

test('sniffImage detects avif brands', () => {
  assert.equal(
    sniffImage(bytes(0x00, 0x00, 0x00, 0x1c, ...ascii('ftyp'), ...ascii('avif'))),
    'image/avif',
  )
  assert.equal(
    sniffImage(bytes(0x00, 0x00, 0x00, 0x1c, ...ascii('ftyp'), ...ascii('avis'))),
    'image/avif',
  )
})

test('sniffImage returns null for non-image buffers', () => {
  assert.equal(sniffImage(bytes(0x00, 0x01, 0x02, 0x03)), null)
  assert.equal(sniffImage(new Uint8Array()), null)
  assert.equal(sniffImage(bytes(...ascii('RIFF'), 0x00, 0x00, 0x00, 0x00, ...ascii('AVI '))), null)
})
