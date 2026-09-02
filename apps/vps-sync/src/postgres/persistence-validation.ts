import type {
  CompleteStateInput,
  MediaResultInput,
  PendingPublicationInput,
  PublicationClaimInput,
  PublicationVerificationInput,
  RunFinishInput,
  RunStartInput,
  UnclaimedPendingCleanupInput,
} from './repositories.ts'

const completeStateKeys = new Set(['runId', 'observedAt', 'users', 'calendarEntries'])
const runStartKeys = new Set([
  'id', 'source', 'mode', 'stage', 'status', 'startedAt', 'heartbeatAt', 'gitSha',
])
const runFinishKeys = new Set([
  'id', 'stage', 'status', 'heartbeatAt', 'finishedAt', 'counts', 'stageDurations',
  'sanitizedError', 'components',
])
const mediaResultKeys = new Set([
  'subjectId', 'detail', 'metadata', 'imageRefs', 'detailHash', 'metadataHash', 'imageHash',
  'status', 'observedAt', 'runId', 'nextRetryAt', 'deletedAt', 'lastSuccessAt',
])
const pendingPublicationKeys = new Set(['generation', 'contentHash', 'objectKey', 'runId', 'createdAt'])
const publicationClaimKeys = new Set(['generation', 'contentHash', 'objectKey', 'runId', 'claimedAt'])
const unclaimedPendingCleanupKeys = new Set(['verifiedGeneration', 'verifiedContentHash'])
const publicationVerificationKeys = new Set([
  'generation', 'contentHash', 'objectKey', 'runId', 'claimedAt', 'verifiedAt',
])
const subjectPayloadKeys = new Set([
  'id', 'type', 'name', 'name_cn', 'summary', 'nsfw', 'date', 'eps', 'total_episodes', 'images', 'rating',
])
const subjectInputKeys = new Set(['id', 'subjectType', 'payload', 'contentHash', 'upstreamUpdatedAt'])
const subjectImageKeys = new Set(['common', 'large'])
const subjectRatingKeys = new Set(['score', 'rank', 'total'])
const collectionPayloadKeys = new Set([
  'type', 'collection_type', 'rate', 'tags', 'comment', 'ep_status', 'vol_status', 'private',
])
const collectionInputKeys = new Set(['payload', 'contentHash', 'upstreamUpdatedAt'])
const calendarPayloadKeys = new Set(['weekday', 'subject_id'])
const calendarWeekdayKeys = new Set(['id', 'en', 'cn', 'ja'])
const mediaDetailKeys = new Set(['id', 'type', 'name', 'name_cn', 'summary', 'nsfw', 'date', 'eps', 'total_episodes'])
const mediaMetadataKeys = new Set(['exists', 'nsfw', 'checked_at', 'expires_at', 'reason'])
const mediaImageRefsKeys = new Set(['common', 'large'])
const imageReferenceKeys = new Set(['hash', 'uri', 'r2_key'])
const mediaStatusKeys = new Set(['detail', 'metadata', 'image'])
const runCountKeys = new Set([
  'users', 'collections', 'inserted', 'updated', 'unchanged', 'missing', 'deleted', 'restored',
  'mediaSelected', 'mediaSucceeded', 'mediaFailed',
])
const runStageDurationKeys = new Set([
  'collection', 'calendar', 'completeState', 'media', 'publication', 'backup', 'notification',
])
const runComponentKeys = new Set(['collection', 'calendar', 'media', 'publication', 'backup', 'notification'])
const sanitizedErrorKeys = new Set(['category', 'code', 'attemptCount', 'stage'])
const subjectPayloadRequiredKeys = new Set(['id'])
const subjectInputRequiredKeys = new Set(subjectInputKeys)
const subjectRatingRequiredKeys = new Set<string>()
const collectionInputRequiredKeys = new Set(collectionInputKeys)
const calendarPayloadRequiredKeys = new Set(calendarPayloadKeys)
const calendarWeekdayRequiredKeys = new Set(['id'])
const mediaMetadataRequiredKeys = new Set(['exists', 'nsfw', 'checked_at', 'reason'])
const mediaImageRefsRequiredKeys = new Set(mediaImageRefsKeys)
const imageReferenceRequiredKeys = new Set(imageReferenceKeys)
const sanitizedErrorRequiredKeys = new Set(sanitizedErrorKeys)
const runSources = new Set(['scheduled', 'manual'])
const runModes = new Set(['shadow', 'live'])
const runStartStatuses = new Set(['running', 'skipped'])
const runFinishStatuses = new Set(['success', 'no_change', 'partial', 'failed', 'skipped'])
const mediaComponentStatuses = new Set([
  'pending', 'success', 'failed', 'missing', 'not_found', 'not_modified',
])
const mediaMetadataReasons = new Set([
  'subject_detail', 'not_found', 'not_found_or_restricted', 'network_error', 'upstream_error',
])
const runComponentResults = new Set([
  'success', 'no_change', 'partial', 'failed', 'skipped', 'not_attempted',
])

export function assertRunStartInput(input: RunStartInput): void {
  const run = assertExactObject(input, runStartKeys, runStartKeys, 'run')
  assertString(run.id, 'run.id')
  assertEnum(run.source, runSources, 'run.source')
  assertEnum(run.mode, runModes, 'run.mode')
  assertString(run.stage, 'run.stage')
  assertEnum(run.status, runStartStatuses, 'run.status')
  assertTimestamp(run.startedAt, 'run.startedAt')
  assertTimestamp(run.heartbeatAt, 'run.heartbeatAt')
  assertString(run.gitSha, 'run.gitSha')
}

export function assertCompleteStateInput(input: CompleteStateInput): void {
  const state = assertExactObject(input, completeStateKeys, completeStateKeys, 'completeState')
  assertString(state.runId, 'runId')
  assertTimestamp(state.observedAt, 'observedAt')
  assertArray(state.users, 'users')
  for (const [userIndex, user] of state.users.entries()) {
    const userPath = `users[${userIndex}]`
    const userRecord = assertExactObject(user, new Set(['id', 'upstreamUserId', 'items']), new Set(['id', 'upstreamUserId', 'items']), userPath)
    assertString(userRecord.id, `${userPath}.id`)
    assertString(userRecord.upstreamUserId, `${userPath}.upstreamUserId`)
    assertArray(userRecord.items, `${userPath}.items`)
    for (const [itemIndex, item] of userRecord.items.entries()) {
      const itemPath = `${userPath}.items[${itemIndex}]`
      const itemRecord = assertExactObject(item, new Set(['subject', 'collection']), new Set(['subject', 'collection']), itemPath)
      assertSubjectInput(itemRecord.subject, `${itemPath}.subject`)
      assertCollectionInput(itemRecord.collection, `${itemPath}.collection`)
    }
  }
  assertArray(state.calendarEntries, 'calendarEntries')
  for (const [entryIndex, entry] of state.calendarEntries.entries()) {
    const entryPath = `calendarEntries[${entryIndex}]`
    const entryRecord = assertExactObject(
      entry,
      new Set(['weekdayId', 'subjectId', 'subject', 'payload']),
      new Set(['weekdayId', 'subjectId', 'subject', 'payload']),
      entryPath,
    )
    assertFiniteNumber(entryRecord.weekdayId, `${entryPath}.weekdayId`)
    assertFiniteNumber(entryRecord.subjectId, `${entryPath}.subjectId`)
    assertSubjectInput(entryRecord.subject, `${entryPath}.subject`)
    assertCalendarPayload(entryRecord.payload, `${entryPath}.payload`)
  }
}

export function assertMediaResultInput(input: MediaResultInput): void {
  const media = assertExactObject(input, mediaResultKeys, mediaResultKeys, 'media')
  assertFiniteNumber(media.subjectId, 'media.subjectId')
  if (media.detail !== null) assertMediaDetail(media.detail, 'media.detail')
  if (media.metadata !== null) assertMediaMetadata(media.metadata, 'media.metadata')
  if (media.imageRefs !== null) assertMediaImageRefs(media.imageRefs, 'media.imageRefs')
  assertNullableString(media.detailHash, 'media.detailHash')
  assertNullableString(media.metadataHash, 'media.metadataHash')
  assertNullableString(media.imageHash, 'media.imageHash')
  assertMediaStatus(media.status, 'media.status')
  assertTimestamp(media.observedAt, 'media.observedAt')
  assertString(media.runId, 'media.runId')
  assertNullableTimestamp(media.nextRetryAt, 'media.nextRetryAt')
  assertNullableTimestamp(media.deletedAt, 'media.deletedAt')
  assertNullableTimestamp(media.lastSuccessAt, 'media.lastSuccessAt')
}

export function assertPendingPublicationInput(input: PendingPublicationInput): void {
  const publication = assertExactObject(input, pendingPublicationKeys, pendingPublicationKeys, 'publication.pending')
  assertFiniteNumber(publication.generation, 'publication.pending.generation')
  assertString(publication.contentHash, 'publication.pending.contentHash')
  assertString(publication.objectKey, 'publication.pending.objectKey')
  assertString(publication.runId, 'publication.pending.runId')
  assertTimestamp(publication.createdAt, 'publication.pending.createdAt')
}

export function assertPublicationClaimInput(input: PublicationClaimInput): void {
  const publication = assertExactObject(input, publicationClaimKeys, publicationClaimKeys, 'publication.claim')
  assertFiniteNumber(publication.generation, 'publication.claim.generation')
  assertString(publication.contentHash, 'publication.claim.contentHash')
  assertString(publication.objectKey, 'publication.claim.objectKey')
  assertString(publication.runId, 'publication.claim.runId')
  assertTimestamp(publication.claimedAt, 'publication.claim.claimedAt')
}

export function assertUnclaimedPendingCleanupInput(input: UnclaimedPendingCleanupInput): void {
  const publication = assertExactObject(
    input,
    unclaimedPendingCleanupKeys,
    unclaimedPendingCleanupKeys,
    'publication.cleanup',
  )
  assertFiniteNumber(publication.verifiedGeneration, 'publication.cleanup.verifiedGeneration')
  assertNullableString(publication.verifiedContentHash, 'publication.cleanup.verifiedContentHash')
}

export function assertPublicationVerificationInput(input: PublicationVerificationInput): void {
  const publication = assertExactObject(
    input,
    publicationVerificationKeys,
    publicationVerificationKeys,
    'publication.verification',
  )
  assertFiniteNumber(publication.generation, 'publication.verification.generation')
  assertString(publication.contentHash, 'publication.verification.contentHash')
  assertString(publication.objectKey, 'publication.verification.objectKey')
  assertString(publication.runId, 'publication.verification.runId')
  assertTimestamp(publication.claimedAt, 'publication.verification.claimedAt')
  assertTimestamp(publication.verifiedAt, 'publication.verification.verifiedAt')
}

export function assertRunFinishInput(input: RunFinishInput): void {
  const run = assertExactObject(input, runFinishKeys, runFinishKeys, 'run')
  assertString(run.id, 'run.id')
  assertString(run.stage, 'run.stage')
  assertEnum(run.status, runFinishStatuses, 'run.status')
  assertTimestamp(run.heartbeatAt, 'run.heartbeatAt')
  assertTimestamp(run.finishedAt, 'run.finishedAt')
  assertFiniteNumberMap(run.counts, runCountKeys, 'run.counts')
  assertFiniteNumberMap(run.stageDurations, runStageDurationKeys, 'run.stageDurations')
  if (run.sanitizedError !== null) assertSanitizedError(run.sanitizedError, 'run.sanitizedError')
  const components = assertExactObject(run.components, runComponentKeys, new Set(), 'run.components')
  for (const [key, value] of Object.entries(components)) {
    assertEnum(value, runComponentResults, `run.components.${key}`)
  }
}

function assertSubjectInput(value: unknown, path: string): void {
  const subject = assertExactObject(value, subjectInputKeys, subjectInputRequiredKeys, path)
  assertFiniteNumber(subject.id, `${path}.id`)
  assertFiniteNumber(subject.subjectType, `${path}.subjectType`)
  assertSubjectPayload(subject.payload, `${path}.payload`)
  assertString(subject.contentHash, `${path}.contentHash`)
  assertNullableTimestamp(subject.upstreamUpdatedAt, `${path}.upstreamUpdatedAt`)
}

function assertSubjectPayload(value: unknown, path: string): void {
  const payload = assertExactObject(value, subjectPayloadKeys, subjectPayloadRequiredKeys, path)
  assertFiniteNumber(payload.id, `${path}.id`)
  assertOptionalFiniteNumber(payload, 'type', path)
  assertOptionalString(payload, 'name', path)
  assertOptionalString(payload, 'name_cn', path)
  assertOptionalString(payload, 'summary', path)
  assertOptionalBoolean(payload, 'nsfw', path)
  assertOptionalString(payload, 'date', path)
  assertOptionalFiniteNumber(payload, 'eps', path)
  assertOptionalFiniteNumber(payload, 'total_episodes', path)
  if (payload.images !== undefined) {
    const images = assertExactObject(payload.images, subjectImageKeys, new Set(), `${path}.images`)
    assertOptionalNullableString(images, 'common', `${path}.images`)
    assertOptionalNullableString(images, 'large', `${path}.images`)
  }
  if (payload.rating !== undefined) {
    const rating = assertExactObject(payload.rating, subjectRatingKeys, subjectRatingRequiredKeys, `${path}.rating`)
    assertOptionalFiniteNumber(rating, 'score', `${path}.rating`)
    assertOptionalFiniteNumber(rating, 'rank', `${path}.rating`)
    assertOptionalFiniteNumber(rating, 'total', `${path}.rating`)
  }
}

function assertCollectionInput(value: unknown, path: string): void {
  const collection = assertExactObject(value, collectionInputKeys, collectionInputRequiredKeys, path)
  assertCollectionPayload(collection.payload, `${path}.payload`)
  assertString(collection.contentHash, `${path}.contentHash`)
  assertNullableTimestamp(collection.upstreamUpdatedAt, `${path}.upstreamUpdatedAt`)
}

function assertCollectionPayload(value: unknown, path: string): void {
  const payload = assertExactObject(value, collectionPayloadKeys, new Set(), path)
  assertOptionalFiniteNumber(payload, 'type', path)
  assertOptionalFiniteNumber(payload, 'collection_type', path)
  assertOptionalNullableFiniteNumber(payload, 'rate', path)
  if (payload.tags !== undefined) {
    assertArray(payload.tags, `${path}.tags`)
    payload.tags.forEach((tag, index) => assertString(tag, `${path}.tags[${index}]`))
  }
  assertOptionalString(payload, 'comment', path)
  assertOptionalFiniteNumber(payload, 'ep_status', path)
  assertOptionalFiniteNumber(payload, 'vol_status', path)
  assertOptionalBoolean(payload, 'private', path)
}

function assertCalendarPayload(value: unknown, path: string): void {
  const payload = assertExactObject(value, calendarPayloadKeys, calendarPayloadRequiredKeys, path)
  const weekday = assertExactObject(payload.weekday, calendarWeekdayKeys, calendarWeekdayRequiredKeys, `${path}.weekday`)
  assertFiniteNumber(weekday.id, `${path}.weekday.id`)
  assertOptionalString(weekday, 'en', `${path}.weekday`)
  assertOptionalString(weekday, 'cn', `${path}.weekday`)
  assertOptionalString(weekday, 'ja', `${path}.weekday`)
  assertFiniteNumber(payload.subject_id, `${path}.subject_id`)
}

function assertMediaDetail(value: unknown, path: string): void {
  const detail = assertExactObject(value, mediaDetailKeys, new Set(), path)
  assertOptionalFiniteNumber(detail, 'id', path)
  assertOptionalFiniteNumber(detail, 'type', path)
  assertOptionalString(detail, 'name', path)
  assertOptionalString(detail, 'name_cn', path)
  assertOptionalString(detail, 'summary', path)
  assertOptionalBoolean(detail, 'nsfw', path)
  assertOptionalString(detail, 'date', path)
  assertOptionalFiniteNumber(detail, 'eps', path)
  assertOptionalFiniteNumber(detail, 'total_episodes', path)
}

function assertMediaMetadata(value: unknown, path: string): void {
  const metadata = assertExactObject(value, mediaMetadataKeys, mediaMetadataRequiredKeys, path)
  if (metadata.exists !== null) assertBoolean(metadata.exists, `${path}.exists`)
  assertBoolean(metadata.nsfw, `${path}.nsfw`)
  assertFiniteNumber(metadata.checked_at, `${path}.checked_at`)
  if (metadata.expires_at !== undefined && metadata.expires_at !== null) {
    assertFiniteNumber(metadata.expires_at, `${path}.expires_at`)
  }
  assertEnum(metadata.reason, mediaMetadataReasons, `${path}.reason`)
}

function assertMediaImageRefs(value: unknown, path: string): void {
  const refs = assertExactObject(value, mediaImageRefsKeys, mediaImageRefsRequiredKeys, path)
  if (refs.common !== null) assertImageReference(refs.common, `${path}.common`)
  if (refs.large !== null) assertImageReference(refs.large, `${path}.large`)
}

function assertImageReference(value: unknown, path: string): void {
  const reference = assertExactObject(value, imageReferenceKeys, imageReferenceRequiredKeys, path)
  assertString(reference.hash, `${path}.hash`)
  assertString(reference.uri, `${path}.uri`)
  assertString(reference.r2_key, `${path}.r2_key`)
}

function assertMediaStatus(value: unknown, path: string): void {
  const status = assertExactObject(value, mediaStatusKeys, new Set(), path)
  for (const [key, component] of Object.entries(status)) {
    assertEnum(component, mediaComponentStatuses, `${path}.${key}`)
  }
}

function assertSanitizedError(value: unknown, path: string): void {
  const error = assertExactObject(value, sanitizedErrorKeys, sanitizedErrorRequiredKeys, path)
  assertString(error.category, `${path}.category`)
  assertString(error.code, `${path}.code`)
  assertFiniteNumber(error.attemptCount, `${path}.attemptCount`)
  assertString(error.stage, `${path}.stage`)
}

function assertFiniteNumberMap(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  const record = assertExactObject(value, allowed, new Set(), path)
  for (const [key, item] of Object.entries(record)) assertFiniteNumber(item, `${path}.${key}`)
}

function assertExactObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  required: ReadonlySet<string>,
  path: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidPersistenceShape(path)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidPersistenceShape(path)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) invalidPersistenceShape(`${path}.${key}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) invalidPersistenceShape(`${path}.${key}`)
  }
  return record
}

function assertArray(value: unknown, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) invalidPersistenceShape(path)
}

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidPersistenceShape(path)
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') invalidPersistenceShape(path)
}

function assertNullableString(value: unknown, path: string): void {
  if (value !== null) assertString(value, path)
}

function assertBoolean(value: unknown, path: string): void {
  if (typeof value !== 'boolean') invalidPersistenceShape(path)
}

function assertOptionalFiniteNumber(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) assertFiniteNumber(record[key], `${path}.${key}`)
}

function assertOptionalNullableFiniteNumber(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined && record[key] !== null) assertFiniteNumber(record[key], `${path}.${key}`)
}

function assertOptionalString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) assertString(record[key], `${path}.${key}`)
}

function assertOptionalNullableString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) assertNullableString(record[key], `${path}.${key}`)
}

function assertOptionalBoolean(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) assertBoolean(record[key], `${path}.${key}`)
}

function assertNullableTimestamp(value: unknown, path: string): void {
  if (value !== null) assertTimestamp(value, path)
}

function assertTimestamp(value: unknown, path: string): void {
  assertString(value, path)
  if (!Number.isFinite(Date.parse(value))) throw new Error(`INVALID_PERSISTENCE_TIMESTAMP: ${path}`)
}

function assertEnum(value: unknown, allowed: ReadonlySet<string>, path: string): void {
  if (typeof value !== 'string' || !allowed.has(value)) invalidPersistenceShape(path)
}

function invalidPersistenceShape(path: string): never {
  throw new Error(`FORBIDDEN_PERSISTENCE_SHAPE: ${path}`)
}
