/**
 * #205 UX-001 / UX-009: one CLI interaction layer.
 *
 * Modern mode (@clack/prompts) is used on a real TTY: arrow-key selection,
 * masked password entry with paste support, spinners and staged progress.
 * Plain mode (non-TTY, NO_COLOR-only scripts, or AIRINGCAL_WIZARD_PLAIN_PROMPTS=1)
 * keeps the tested line-based prompts and emits no ANSI escapes.
 *
 * Theme: neutral foreground styling only — the terminal background is never
 * changed. `AIRINGCAL_THEME=auto|dark|light` selects an optional palette;
 * status meaning is always carried by symbols and words, never color alone.
 * NO_COLOR disables all styling and hyperlinks.
 */

import * as clack from '@clack/prompts'

import { askConfirm, askSecret, askSelect, askText, WizardAbort } from './setup-prompt.mjs'

const SYMBOLS = Object.freeze({ step: '›', ok: '✓', warn: '!', error: '✗', info: '·' })

const PALETTE = Object.freeze({
  auto: { accent: '\u001b[36m', ok: '\u001b[32m', warn: '\u001b[33m', error: '\u001b[31m', dim: '\u001b[2m', reset: '\u001b[0m' },
  dark: { accent: '\u001b[96m', ok: '\u001b[92m', warn: '\u001b[93m', error: '\u001b[91m', dim: '\u001b[2m', reset: '\u001b[0m' },
  light: { accent: '\u001b[36m', ok: '\u001b[32m', warn: '\u001b[33m', error: '\u001b[31m', dim: '\u001b[2m', reset: '\u001b[0m' },
})

function resolveTheme(env) {
  const requested = String(env.AIRINGCAL_THEME ?? 'auto').trim().toLowerCase()
  return PALETTE[requested] ? requested : 'auto'
}

export function createUi({ io = { input: process.stdin, output: process.stderr }, env = process.env } = {}) {
  const interactive = Boolean(io.input?.isTTY)
  const plain = !interactive || String(env.AIRINGCAL_WIZARD_PLAIN_PROMPTS ?? '') === '1'
  const useColor = interactive && !('NO_COLOR' in env) && String(env.TERM ?? '') !== 'dumb'
  const themeName = resolveTheme(env)
  const palette = PALETTE[themeName]
  const paint = (key, text) => (useColor ? `${palette[key]}${text}${palette.reset}` : text)
  const out = io.output ?? process.stderr
  const write = (line = '') => out.write(`${line}\n`)
  const link = (label, url) => {
    if (!url) return ''
    if (!useColor || url.startsWith('docs/')) return `${label}: ${url}`
    return `\u001b]8;;${url}\u0007${label}\u001b]8;;\u0007 (${url})`
  }
  const log = {
    info: (message) => write(`${paint('accent', SYMBOLS.info)} ${message}`),
    step: (message) => write(`${paint('accent', SYMBOLS.step)} ${message}`),
    success: (message) => write(`${paint('ok', SYMBOLS.ok)} ${message}`),
    warn: (message) => write(`${paint('warn', SYMBOLS.warn)} ${message}`),
    error: (message) => write(`${paint('error', SYMBOLS.error)} ${message}`),
  }

  const plainPrompts = {
    select: (arg) => {
      const { message, options } = typeof arg === 'string' ? { message: arg, options: [] } : arg
      return askSelect(message, options.map((option) => ({
      title: option.label,
      hint: option.hint,
      value: option.value,
    })), io)
    },
    confirm: (arg, initialValue) => {
      const normalized = typeof arg === 'string' ? { message: arg, initialValue } : arg
      return askConfirm(normalized.message, io, { defaultYes: Boolean(normalized.initialValue) })
    },
    text: (arg) => {
      const normalized = typeof arg === 'string' ? { message: arg } : arg
      return askText(normalized.message, io, { validate: normalized.validate
        ? (value) => normalized.validate(value) ?? null
        : undefined }).then((value) => value || normalized.defaultValue || value)
    },
    password: (arg) => {
      const { message, validate } = typeof arg === 'string' ? { message: arg } : arg
      return askSecret(message, io).then((value) => {
      const problem = validate ? validate(value) : undefined
        if (problem) throw new WizardAbort(`${message}: ${problem}`)
        return value
      })
    },
  }

  const normalize = (arg, initialValue) => (typeof arg === 'string' ? { message: arg, initialValue } : arg)
  const clackPrompts = {
    select: async (arg) => {
      const { message, options, initialValue } = normalize(arg)
      const result = await clack.select({
        message,
        options: options.map((option) => ({ value: option.value, label: option.label, hint: option.hint })),
        initialValue,
      })
      if (clack.isCancel(result)) throw new WizardAbort('Selection cancelled')
      return result
    },
    confirm: async (arg, initialValue) => {
      const normalized = normalize(arg, initialValue)
      const result = await clack.confirm({
        message: normalized.message,
        initialValue: Boolean(normalized.initialValue),
      })
      if (clack.isCancel(result)) throw new WizardAbort('Confirmation cancelled')
      return Boolean(result)
    },
    text: async (arg) => {
      const { message, placeholder, defaultValue, validate } = normalize(arg)
      const result = await clack.text({
        message,
        placeholder,
        defaultValue,
        validate: validate ? (value) => validate(value) : undefined,
      })
      if (clack.isCancel(result)) throw new WizardAbort('Input cancelled')
      return String(result ?? '')
    },
    password: async (arg) => {
      const { message, validate } = normalize(arg)
      const result = await clack.password({
        message,
        mask: '*',
        validate: validate ? (value) => validate(value) : undefined,
      })
      if (clack.isCancel(result)) throw new WizardAbort('Credential entry cancelled')
      return String(result ?? '')
    },
  }

  const prompts = plain ? plainPrompts : clackPrompts
  const spinner = () => {
    if (plain) {
      return { start: (message) => log.step(message), stop: (message) => message && log.success(message), fail: (message) => message && log.error(message) }
    }
    const instance = clack.spinner()
    return {
      start: (message) => instance.start(message),
      stop: (message) => instance.stop(message),
      fail: (message) => instance.stop(message, 1),
    }
  }

  return {
    interactive: !plain,
    color: useColor,
    theme: themeName,
    prompts,
    link,
    log,
    spinner,
    intro: (title) => { if (plain) write(title); else clack.intro(title) },
    outro: (message) => { if (plain) write(message); else clack.outro(message) },
    note: (message, title) => {
      if (plain) { if (title) write(title); write(message) } else clack.note(message, title)
    },
    cancel: (message) => { if (!plain) clack.cancel(message); else write(message) },
    select: prompts.select,
    confirm: prompts.confirm,
    text: prompts.text,
    password: prompts.password,
  }
}

/** Render a credential section with purpose, links and secure-entry hint. */
export function credentialSection(ui, { title, purpose, links }) {
  ui.log.step(title)
  ui.log.info(purpose)
  for (const link of links) {
    ui.log.info(link.local ? link.url : ui.link(link.label, link.url))
  }
}
