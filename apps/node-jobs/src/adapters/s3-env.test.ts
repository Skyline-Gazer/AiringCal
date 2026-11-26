import assert from 'node:assert/strict'
import test from 'node:test'
import { readS3BucketConfig, readCheckpointS3Config, readPublicS3Config } from './s3-env.ts'

test('readS3BucketConfig requires endpoint bucket and keys', () => {
  assert.equal(
    readS3BucketConfig({}, {
      endpoint: 'AIRINGCAL_CHECKPOINT_S3_ENDPOINT',
      region: 'AIRINGCAL_CHECKPOINT_S3_REGION',
      bucket: 'AIRINGCAL_CHECKPOINT_S3_BUCKET',
      accessKeyId: 'AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID',
      secretAccessKey: 'AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY',
    }),
    null,
  )

  const cfg = readS3BucketConfig(
    {
      AIRINGCAL_CHECKPOINT_S3_ENDPOINT: ' https://PLACEHOLDER_ACCOUNT_ID.r2.cloudflarestorage.com ',
      AIRINGCAL_CHECKPOINT_S3_BUCKET: 'PLACEHOLDER_CHECKPOINT_BUCKET',
      AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID: 'PLACEHOLDER_CHECKPOINT_ACCESS_KEY_ID',
      AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY: 'PLACEHOLDER_CHECKPOINT_SECRET_ACCESS_KEY',
    },
    {
      endpoint: 'AIRINGCAL_CHECKPOINT_S3_ENDPOINT',
      region: 'AIRINGCAL_CHECKPOINT_S3_REGION',
      bucket: 'AIRINGCAL_CHECKPOINT_S3_BUCKET',
      accessKeyId: 'AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID',
      secretAccessKey: 'AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY',
    },
  )
  assert.deepEqual(cfg, {
    endpoint: 'https://PLACEHOLDER_ACCOUNT_ID.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'PLACEHOLDER_CHECKPOINT_BUCKET',
    accessKeyId: 'PLACEHOLDER_CHECKPOINT_ACCESS_KEY_ID',
    secretAccessKey: 'PLACEHOLDER_CHECKPOINT_SECRET_ACCESS_KEY',
  })
})

test('readCheckpointS3Config and readPublicS3Config use distinct env prefixes', () => {
  const env = {
    AIRINGCAL_CHECKPOINT_S3_ENDPOINT: 'https://ckpt.example',
    AIRINGCAL_CHECKPOINT_S3_BUCKET: 'ckpt',
    AIRINGCAL_CHECKPOINT_S3_ACCESS_KEY_ID: 'ck',
    AIRINGCAL_CHECKPOINT_S3_SECRET_ACCESS_KEY: 'cs',
    AIRINGCAL_PUBLIC_S3_ENDPOINT: 'https://pub.example',
    AIRINGCAL_PUBLIC_S3_BUCKET: 'pub',
    AIRINGCAL_PUBLIC_S3_ACCESS_KEY_ID: 'pk',
    AIRINGCAL_PUBLIC_S3_SECRET_ACCESS_KEY: 'ps',
    AIRINGCAL_PUBLIC_S3_REGION: 'wnam',
  }
  assert.equal(readCheckpointS3Config(env)?.bucket, 'ckpt')
  assert.equal(readPublicS3Config(env)?.bucket, 'pub')
  assert.equal(readPublicS3Config(env)?.region, 'wnam')
})
