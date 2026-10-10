import { exitCode } from '../contracts.ts'
import { runBackup } from '../backup/run.ts'

const summary = await runBackup()
console.log(JSON.stringify(summary))
process.exit(exitCode(summary))
