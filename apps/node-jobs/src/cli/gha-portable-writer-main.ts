import { exitCode } from '../contracts.ts'
import { readCheckpointS3Config } from '../adapters/s3-env.ts'
import { createS3ObjectStore } from '../adapters/s3-object-store.ts'
import { runGhaPortableWriter } from './gha-portable-writer.ts'

async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  const checkpointConfig = readCheckpointS3Config(env)
  if (!checkpointConfig) {
    console.error(JSON.stringify({
      status: 'failed',
      message: 'Checkpoint S3 env incomplete (AIRINGCAL_CHECKPOINT_S3_*)',
    }))
    return 1
  }
  const checkpointStore = createS3ObjectStore(checkpointConfig)
  try {
    const result = await runGhaPortableWriter({ env, checkpointStore })
    console.log(JSON.stringify(result))
    if (result.status === 'failed') {
      return result.summary ? exitCode(result.summary) : 1
    }
    return 0
  } finally {
    checkpointStore.close()
  }
}

if (process.argv[1]?.endsWith('gha-portable-writer-main.ts')
  || process.argv[1]?.endsWith('gha-portable-writer.mjs')) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export { main as runGhaPortableWriterMain }
