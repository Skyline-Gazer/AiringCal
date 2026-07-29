import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isMediaRefreshJobV3,
  isMediaRefreshJobV4,
} from './index.ts'

const base = {
  generation: 7,
  job_id: 'workflow:23080',
  subject_id: 23080,
  title: 'A CN',
  components: ['detail', 'meta', 'image_common', 'image_large'],
  images: {
    common: 'https://img.example/common.jpg',
    large: 'https://img.example/large.jpg',
  },
}

test('canonical media validation keeps live V3 and D1-only V4 unambiguous', () => {
  assert.equal(isMediaRefreshJobV3({ ...base, version: 3 }), true)
  const v4 = {
    ...base,
    version: 4,
    generation: { observed_at: 1_785_104_400, run_id: 'shadow-run' },
  }
  assert.equal(isMediaRefreshJobV3(v4), false)
  assert.equal(isMediaRefreshJobV4(v4), true)
  assert.equal(isMediaRefreshJobV4({ ...v4, version: 3 }), false)
})

test('canonical media validation rejects malformed generated jobs', () => {
  for (const invalid of [
    { ...base, version: 4, generation: -1 },
    { ...base, version: 4, generation: { observed_at: -1, run_id: 'shadow-run' } },
    { ...base, version: 4, generation: { observed_at: 1, run_id: '' } },
    { ...base, version: 4, generation: { observed_at: 1.5, run_id: 'shadow-run' } },
    { ...base, version: 4, job_id: '' },
    { ...base, version: 4, subject_id: 0 },
    { ...base, version: 4, components: ['unknown'] },
    { ...base, version: 4, images: { common: 1 } },
  ]) {
    assert.equal(isMediaRefreshJobV4(invalid), false)
  }
})
