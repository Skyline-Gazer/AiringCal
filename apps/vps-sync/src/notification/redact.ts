const sensitive = /(?:https?|postgres(?:ql)?):\/\/\S+|(?:authorization\s*:\s*bearer|x-[\w-]*(?:token|key)[\w-]*\s*:|(?:access|refresh)?_?token\s*[=:]|r2_(?:access_key_id|secret_access_key)\s*[=:])\s*\S+|raw exception/gi

/** Removes untrusted transport and credential-shaped text before notification use. */
export function redactText(value: string): string {
  return value.replace(sensitive, '[redacted]').replace(/(?:\[redacted\]\s*){2,}/g, '[redacted] ' ).trim()
}
