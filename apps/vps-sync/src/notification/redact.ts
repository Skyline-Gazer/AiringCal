const sensitive = [
  /\b[a-z][a-z\d+.-]{1,31}:\/\/[^\s"'<>]+/gi,
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*\S+(?:\s+\S+)?/gi,
  /\b(?:bearer|basic)\s+\S+/gi,
  /\b(?:x-[\w-]+|(?:database|webhook|r2)_[\w-]+|[\w-]*(?:token|secret|password|credential|key)[\w-]*)\s*[:=]\s*\S+/gi,
  /\braw exception\b(?:\s*[:=]\s*.*)?/gi,
]

/** Removes transport, credential, and raw-exception-shaped text before notification use. */
export function redactText(value: string): string {
  return sensitive.reduce((text, pattern) => text.replace(pattern, '[redacted]'), value)
    .replace(/(?:\[redacted\]\s*){2,}/g, '[redacted] ')
    .trim()
}
