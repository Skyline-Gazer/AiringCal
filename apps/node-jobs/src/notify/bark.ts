export interface BarkConfig {
  url: string
}

export interface BarkPayload {
  title: string
  body: string
}

export interface BarkNotifyDeps {
  fetch?: typeof fetch
}

export function readBarkConfig(env: Record<string, string | undefined>): BarkConfig | null {
  const url = env.BARK_URL?.trim()
  if (!url) return null
  return { url }
}

export async function notifyBarkFailure(
  env: Record<string, string | undefined>,
  payload: BarkPayload,
  deps: BarkNotifyDeps = {},
): Promise<void> {
  const config = readBarkConfig(env)
  if (!config) return
  const fetchImpl = deps.fetch ?? fetch
  const response = await fetchImpl(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ title: payload.title, body: payload.body }),
  })
  if (!response.ok) {
    throw new Error(`Bark notify failed: ${response.status}`)
  }
}
