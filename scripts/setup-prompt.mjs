/**
 * Zero-dependency terminal prompts for `pnpm setup` (#195 P4).
 *
 * Every function takes an injectable `{ input, output }` pair so the wizard
 * is fully testable without a real TTY. Secrets are entered through
 * `askSecret`, which reads raw keypresses and echoes only `*` — the value
 * never reaches an output stream, process argv, or shell history. Non-TTY
 * input aborts instead of hanging; the headless path must supply values via
 * the documented environment variables instead.
 */

export class WizardAbort extends Error {
  constructor(message) {
    super(message)
    this.name = 'WizardAbort'
    this.code = 'WIZARD_ABORT'
  }
}

/**
 * Raw single-line reader. `secret` masks every printable character with `*`;
 * visible mode echoes the character (used for hostnames, not credentials).
 * Handles Enter (\\r/\\n), Backspace, Ctrl-U (clear), Ctrl-C (abort) and
 * stream close (abort). Terminal modes are always restored.
 */
export function askLine(label, io, { secret = false } = {}) {
  const { input, output } = io
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new WizardAbort(
        `${label}: no interactive terminal available (stdin is not a TTY). ` +
        'Provide the value through the documented environment variables and run headless.',
      ))
      return
    }
    // #195 correction: raw mode MUST be enabled before the prompt is echoed,
    // otherwise a fast typist's secret can be echoed in plaintext by the TTY.
    try {
      input.setRawMode(true)
    } catch (error) {
      reject(new WizardAbort(`${label}: cannot enter secure input mode (${error.message})`))
      return
    }
    output.write(`${label}: `)
    let value = ''
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      input.removeListener('data', onData)
      input.removeListener('close', onClose)
      try { input.setRawMode(false) } catch { /* already detached */ }
      input.pause()
    }
    const onData = (chunk) => {
      const text = chunk.toString('utf8')
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          cleanup()
          output.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') {
          cleanup()
          output.write('^C\n')
          reject(new WizardAbort(`${label}: cancelled by user`))
          return
        }
        if (char === '\u0004') {
          cleanup()
          output.write('\n')
          reject(new WizardAbort(`${label}: input closed (EOF)`))
          return
        }
        if (char === '\u0015') {
          if (value.length > 0) {
            output.write('\b \b'.repeat(value.length))
            value = ''
          }
          continue
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1)
            output.write('\b \b')
          }
          continue
        }
        if (char >= ' ') {
          value += char
          output.write(secret ? '*' : char)
        }
      }
    }
    const onClose = () => {
      cleanup()
      reject(new WizardAbort(`${label}: input closed (EOF)`))
    }
    input.on('data', onData)
    input.once('close', onClose)
    input.resume()
  })
}

/** Masked credential entry. The value is returned in memory only. */
export function askSecret(label, io) {
  return askLine(label, io, { secret: true })
}

export async function askText(label, io, { validate } = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = (await askLine(label, io, { secret: false })).trim()
    if (!validate) return value
    const problem = validate(value)
    if (!problem) return value
    io.output.write(`  ${problem}\n`)
  }
  throw new WizardAbort(`${label}: too many invalid answers`)
}

/**
 * Renders a numbered menu and reads one choice. A single option is returned
 * without prompting (callers pass multi-option lists only when the provider
 * genuinely offers a choice).
 */
export async function askSelect(label, options, io) {
  if (options.length === 0) throw new WizardAbort(`${label}: nothing to select`)
  if (options.length === 1) return options[0].value
  io.output.write(`\n${label}\n`)
  options.forEach((option, index) => {
    const hint = option.hint ? ` — ${option.hint}` : ''
    io.output.write(`  ${index + 1}) ${option.title}${hint}\n`)
  })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await askLine('Choose', io, { secret: false })
    const index = Number(raw.trim())
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      return options[index - 1].value
    }
    io.output.write(`  Enter a number between 1 and ${options.length}.\n`)
  }
  throw new WizardAbort(`${label}: too many invalid choices`)
}

/** y/n gate. Empty answer follows `defaultYes`; anything else re-prompts. */
export async function askConfirm(label, io, { defaultYes = false } = {}) {
  const suffix = defaultYes ? ' [Y/n]' : ' [y/N]'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = (await askLine(`${label}${suffix}`, io, { secret: false })).trim().toLowerCase()
    if (raw === '') return defaultYes
    if (['y', 'yes'].includes(raw)) return true
    if (['n', 'no'].includes(raw)) return false
    io.output.write('  Answer y or n.\n')
  }
  throw new WizardAbort(`${label}: too many invalid answers`)
}
