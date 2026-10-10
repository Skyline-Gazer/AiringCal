import { exitCode } from '../contracts.ts'
import { runSync } from '../sync/run.ts'

const summary = await runSync()
console.log(JSON.stringify(summary))
process.exit(exitCode(summary))
