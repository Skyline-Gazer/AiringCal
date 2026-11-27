const CONFIRMED_KEY = 'bgm-age-confirmed'

function readConfirmed(): boolean {
  try {
    return sessionStorage.getItem(CONFIRMED_KEY) === '1'
  } catch {
    return false
  }
}

let confirmed = readConfirmed()
const listeners = new Set<() => void>()

/** Page-global consent: every mounted widget observes the same answer. */
export function isAgeConfirmed(): boolean {
  return confirmed
}

export function subscribeAgeConfirmation(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function confirmAge(): void {
  confirmed = true
  try {
    sessionStorage.setItem(CONFIRMED_KEY, '1')
  } catch {
    // storage unavailable: the confirmation still applies to this page view
  }
  for (const listener of listeners) listener()
}

export function leaveSite(): void {
  location.href = 'https://www.google.com'
}
