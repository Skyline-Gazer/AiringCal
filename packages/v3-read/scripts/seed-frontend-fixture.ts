/**
 * Deterministic public-store fixture for frontend acceptance tests.
 * Synthetic data only — never real user data.
 *
 * Usage: pnpm exec tsx scripts/seed-frontend-fixture.ts <publicDir>
 */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { buildPublicSnapshot, canonicalSnapshotBytes } from '@airing-cal/domain'
import {
  canonicalJson,
  type PublicCalendarDayV1,
  type PublicCalendarSubjectV1,
  type PublicCollectionItemV1,
  type PublicSubjectImagesV1,
} from '@airing-cal/storage'

const publicDir = process.argv[2]
if (!publicDir) {
  console.error(JSON.stringify({ status: 'failed', stage: 'seed_frontend_fixture', message: 'publicDir is required' }))
  process.exit(1)
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function coverPng(width: number, height: number, seed: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const rows: Buffer[] = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3)
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2
      row[1 + x * 3] = Math.max(0, Math.min(255, Math.round(30 + 180 * t + 40 * Math.sin(seed))))
      row[2 + x * 3] = Math.max(0, Math.min(255, Math.round(90 + 120 * t + 40 * Math.cos(seed * 1.7))))
      row[3 + x * 3] = Math.max(0, Math.min(255, Math.round(160 - 90 * t + 40 * Math.sin(seed * 2.3))))
    }
    rows.push(row)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', new Uint8Array()),
  ])
}

const imageHashes = new Map<number, string>()
function imageRef(subjectId: number): { hash: string; uri: string; r2Key: string } {
  const hash = createHash('sha256').update(`subject:${subjectId}`).digest('hex')
  imageHashes.set(subjectId, hash)
  return { hash, uri: `/image/${hash}`, r2Key: `images/${hash}/original` }
}

function images(subjectId: number): PublicSubjectImagesV1 {
  const ref = imageRef(subjectId)
  return {
    common: { hash: ref.hash, uri: ref.uri, r2_key: ref.r2Key },
    large: { hash: ref.hash, uri: `/image/${ref.hash}`, r2_key: ref.r2Key },
  }
}

const LONG_ZH = '这是一个非常非常长的中文番剧标题用来验证卡片标题在窄屏和宽屏下是否溢出以及是否被正确截断'
const LONG_EN = 'A Very Long English Anime Title That Should Never Blow Up The Card Layout Even On Aggressive Zoom Levels'

function collectionItem(subjectId: number, collectionType: number, index: number): PublicCollectionItemV1 {
  return {
    subject_id: subjectId,
    name: index % 7 === 0 ? LONG_EN : `Subject ${subjectId}`,
    name_cn: index % 5 === 0 ? LONG_ZH : `条目 ${subjectId}`,
    summary: 'fixture summary',
    images: images(subjectId),
    image_status: { common: 'cached', large: 'cached' },
    rating: { score: 6 + (index % 40) / 10, rank: 100 + index, total: 500 },
    eps: 12 + (index % 4),
    total_episodes: 12 + (index % 4),
    ep_status: index % 13,
    vol_status: 0,
    type: 2,
    collection_type: collectionType,
    rate: 7,
    nsfw: index % 19 === 0,
    date: '2026-11-27',
    tags: ['fixture'],
    updated_at: '2026-11-27T00:00:00Z',
  }
}

const TYPES: { type: number; count: number }[] = [
  { type: 1, count: 26 },
  { type: 2, count: 71 },
  { type: 3, count: 55 },
  { type: 4, count: 9 },
  { type: 5, count: 4 },
]

const collections: PublicCollectionItemV1[] = []
let nextId = 30_000
for (const { type, count } of TYPES) {
  for (let i = 0; i < count; i += 1) collections.push(collectionItem(nextId++, type, i))
}

const WEEKDAYS = [
  { en: 'Mon', cn: '星期一', ja: '月', id: 1 },
  { en: 'Tue', cn: '星期二', ja: '火', id: 2 },
  { en: 'Wed', cn: '星期三', ja: '水', id: 3 },
  { en: 'Thu', cn: '星期四', ja: '木', id: 4 },
  { en: 'Fri', cn: '星期五', ja: '金', id: 5 },
  { en: 'Sat', cn: '星期六', ja: '土', id: 6 },
  { en: 'Sun', cn: '星期日', ja: '日', id: 7 },
]
const CALENDAR_COUNTS = [12, 0, 7, 3, 20, 1, 9]

const calendar: PublicCalendarDayV1[] = WEEKDAYS.map((weekday, dayIndex) => ({
  weekday,
  items: Array.from({ length: CALENDAR_COUNTS[dayIndex]! }, (_, i): PublicCalendarSubjectV1 => {
    const subjectId = 40_000 + dayIndex * 100 + i
    return {
      subject_id: subjectId,
      id: subjectId,
      type: 2,
      name: i % 4 === 0 ? LONG_EN : `Subject ${subjectId}`,
      name_cn: i % 3 === 0 ? LONG_ZH : `放送条目 ${subjectId}`,
      summary: 'fixture summary',
      images: images(subjectId),
      image_status: { common: 'cached', large: 'cached' },
      nsfw: dayIndex === 4 && i === 0,
      date: '2026-11-27',
      eps: 12,
      total_episodes: i % 6 === 0 ? 0 : 12,
      rating: { score: 7.2, rank: 200, total: 400 },
    }
  }),
}))

const snapshot = await buildPublicSnapshot({
  collections,
  calendar,
  published_at: 1_796_000_000,
}, 1)

const artifactRef = `snapshots/v1/${snapshot.generation}-${snapshot.content_hash}.json`
const pointer = {
  schema_version: 1,
  generation: snapshot.generation,
  content_hash: snapshot.content_hash,
  artifact_ref: artifactRef,
  published_at_unix: snapshot.published_at,
}

await rm(publicDir, { recursive: true, force: true })
async function put(key: string, body: string | Uint8Array): Promise<void> {
  const path = join(publicDir, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body)
}

await put('public/current-release.json', canonicalJson(pointer))
await put(artifactRef, canonicalSnapshotBytes(snapshot))
for (const [subjectId, hash] of imageHashes) {
  const png = coverPng(300, 400, subjectId / 97)
  await put(`images/${hash}/original`, png)
  await put(`images/${hash}/thumb.v2.webp`, png)
}

console.log(JSON.stringify({
  status: 'ok',
  stage: 'seed_frontend_fixture',
  publicDir,
  total: collections.length,
  calendar: calendar.map((day) => day.items.length),
  contentHash: snapshot.content_hash,
}))
