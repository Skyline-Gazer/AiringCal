/**
 * #205 QA-001: narrow static check for undefined / use-before-declaration
 * identifiers in the .mjs orchestration layer (the exact class of defect that
 * produced BUG-001: `applyDerived is not defined`).
 *
 * Uses the repository's existing TypeScript compiler in checkJs mode and keeps
 * ONLY the relevant diagnostics; unrelated JS type noise never fails the gate.
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const FILES = [
  'scripts/setup-wizard.mjs',
  'scripts/setup-wizard-lib.mjs',
  'scripts/setup-prompt.mjs',
  'scripts/setup-identities.mjs',
  'scripts/setup-validate.mjs',
  'scripts/setup-ui.mjs',
  'scripts/setup-docs.mjs',
  'scripts/mutation-ledger.mjs',
  'scripts/deploy-env-lib.mjs',
  'scripts/deploy-env-live-io.mjs',
  'scripts/deploy-env.mjs',
]
const RELEVANT = /error TS(2304|2552|2448|2454):/
const result = spawnSync(
  process.execPath,
  [
    resolve(ROOT, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--allowJs', '--checkJs',
    '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--skipLibCheck', '--lib', 'es2022,dom',
    ...FILES.map((file) => resolve(ROOT, file)),
  ],
  { encoding: 'utf8', cwd: ROOT },
)
const findings = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  .split(/\r?\n/)
  .filter((line) => RELEVANT.test(line))
if (findings.length > 0) {
  console.error('Undefined or use-before-declaration identifiers found:')
  for (const line of findings) console.error(`  ${line}`)
  process.exit(1)
}
console.log('No undefined identifiers in the wizard orchestration layer.')
