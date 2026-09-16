import assert from 'node:assert/strict'
import test from 'node:test'

type RetentionApi = {
  selectBackupDeletions(entries: readonly string[] | null): string[]
}

async function retentionApi(): Promise<RetentionApi> {
  try {
    return await import('./retention.js') as unknown as RetentionApi
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      assert.fail('backup retention selector is not implemented')
    }
    throw error
  }
}

function point(date: string, time = '030405006', sha = 'a'.repeat(40)) {
  const folder = date.replaceAll('-', '/')
  const stamp = `${date.replaceAll('-', '')}T${time}Z-${sha}`
  const base = `backups/postgres/${folder}/${stamp}`
  return [`${base}.dump`, `${base}.json`]
}

function pointDate(offset: number): string {
  return new Date(Date.UTC(2026, 8, 15 - offset)).toISOString().slice(0, 10)
}

test('retains the latest restore point per UTC date among the newest 30 dates and the latest older point per month', async () => {
  const { selectBackupDeletions } = await retentionApi()
  const points: string[][] = []

  for (let offset = 0; offset < 30; offset += 1) {
    const date = pointDate(offset)
    points.push(point(date, '030405006', offset.toString(16).padStart(40, '0')))
    if (offset === 0) points.push(point(date, '010203004', 'b'.repeat(40)))
  }

  const augustLatest = point('2026-08-16', '230000000', 'c'.repeat(40))
  const augustEarlier = point('2026-08-15', '230000000', 'd'.repeat(40))
  const julyLatest = point('2026-07-31', '230000000', 'e'.repeat(40))
  const julyEarlier = point('2026-07-10', '230000000', 'f'.repeat(40))
  const juneLatest = point('2026-06-05', '230000000', '1'.repeat(40))
  points.push(augustEarlier, augustLatest, julyEarlier, julyLatest, juneLatest)

  const deletions = selectBackupDeletions(points.flat().reverse())
  assert.deepEqual(deletions, [
    ...point('2026-09-15', '010203004', 'b'.repeat(40)),
    ...augustEarlier,
    ...julyEarlier,
  ].sort())
  for (const key of [...augustLatest, ...julyLatest, ...juneLatest]) assert.ok(!deletions.includes(key))
})

test('same UTC date retains only its last complete restore point', async () => {
  const { selectBackupDeletions } = await retentionApi()
  const earlier = point('2026-09-15', '010000000', 'a'.repeat(40))
  const later = point('2026-09-15', '120000000', 'b'.repeat(40))

  assert.deepEqual(selectBackupDeletions([...later, ...earlier]), earlier.sort())
})

test('returns no deletion candidates when different SHAs share the latest timestamp', async () => {
  const { selectBackupDeletions } = await retentionApi()
  const first = point('2026-09-15', '120000000', 'a'.repeat(40))
  const second = point('2026-09-15', '120000000', 'b'.repeat(40))

  assert.deepEqual(selectBackupDeletions([...first, ...second]), [])
})

test('uncertain lists, malformed keys, and unpaired objects produce no deletion candidates', async (t) => {
  const { selectBackupDeletions } = await retentionApi()

  await t.test('null list result', () => {
    assert.deepEqual(selectBackupDeletions(null), [])
  })
  await t.test('malformed key', () => {
    assert.deepEqual(selectBackupDeletions([...point('2026-09-15'), 'backups/postgres/not-a-backup.dump']), [])
  })
  await t.test('unpaired dump', () => {
    assert.deepEqual(selectBackupDeletions(point('2026-09-15').slice(0, 1)), [])
  })
  await t.test('unpaired manifest', () => {
    assert.deepEqual(selectBackupDeletions(point('2026-09-15').slice(1)), [])
  })
  await t.test('folder date must agree with UTC timestamp', () => {
    const [dump, manifest] = point('2026-09-15')
    assert.ok(dump && manifest)
    assert.deepEqual(selectBackupDeletions([
      dump.replace('/09/15/', '/09/14/'),
      manifest.replace('/09/15/', '/09/14/'),
    ]), [])
  })
})
