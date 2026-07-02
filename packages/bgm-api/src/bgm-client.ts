const BGM_BASE = 'https://api.bgm.tv'
const UA = 'markd3ng/AiringCal (https://github.com/markd3ng/AiringCal)'

export type TokenStatus =
  | { status: 'valid'; expires: number }
  | { status: 'invalid' }
  | { status: 'probe_failed' }

export class BgmHttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'BgmHttpError'
  }
}

export class BgmTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BgmTimeoutError'
  }
}

export class BgmNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BgmNetworkError'
  }
}

export interface BgmCollection {
  subject_id: number
  subject_type: number
  rate: number
  type: number
  comment: string
  tags: string[]
  ep_status: number
  vol_status: number
  updated_at: string
  private: boolean
  subject?: BgmSlimSubject
}

export interface BgmSlimSubject {
  id: number
  type: number
  name: string
  name_cn: string
  summary: string
  nsfw: boolean
  date: string
  eps: number
  total_episodes: number
  images: { large: string; common: string; medium: string; small: string; grid: string }
  rating: { score: number; rank: number; total: number }
}

export type BgmSubject = BgmSlimSubject & {
  eps_count?: number
}

export type BgmCalendarSubject = Omit<BgmSlimSubject, 'total_episodes'> & {
  eps_count?: number
  total_episodes?: number
}

export interface BgmCalendarItem {
  weekday: { en: string; cn: string; ja: string; id: number }
  items: BgmCalendarSubject[]
}

export interface BgmEpisodeCollection {
  episode: { id: number }
  type: 0 | 1 | 2 | 3
  updated_at: number
}

export class BgmClient {
  constructor(private token?: string) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'User-Agent': UA }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  /** 统一 fetch 包装：按异常类型分类错误、返回中文错误消息。非 2xx 时附上响应体原文便于排障。 */
  private async fetchJson(url: string, init?: RequestInit): Promise<any> {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new BgmTimeoutError(`请求 bgm.tv 超时 (30s): ${url}`)
      }
      throw new BgmNetworkError(`无法连接 bgm.tv: ${err.message || String(err)}`)
    }
    if (res.status === 401) {
      const body = await res.text().catch(() => '')
      throw new BgmHttpError(401, `bgm.tv 认证失败：token 无效或已过期 (body: ${body.slice(0, 200)})`)
    }
    if (res.status === 403) {
      const body = await res.text().catch(() => '')
      throw new BgmHttpError(403, `bgm.tv 拒绝访问：token 权限不足或 scope 缺失 (body: ${body.slice(0, 200)})`)
    }
    if (res.status === 404) {
      throw new BgmHttpError(404, `bgm.tv 资源不存在：${url}`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new BgmHttpError(res.status, `bgm.tv 返回错误 (${res.status}): ${body.slice(0, 300)}`)
    }
    if (res.status === 204) return undefined
    const body = await res.text()
    if (!body.trim()) return undefined
    return JSON.parse(body)
  }

  async getCollections(username: string, offset = 0, limit = 30): Promise<{ data: BgmCollection[]; total: number }> {
    const url = `${BGM_BASE}/v0/users/${username}/collections?subject_type=2&limit=${limit}&offset=${offset}`
    return this.fetchJson(url, { headers: this.headers(), signal: AbortSignal.timeout(30000) })
  }

  async getSubject(subjectId: number): Promise<BgmSubject | null> {
    const url = `${BGM_BASE}/v0/subjects/${subjectId}`
    try {
      return await this.fetchJson(url, { headers: this.headers(), signal: AbortSignal.timeout(30000) })
    } catch (err) {
      if (err instanceof BgmHttpError && err.status === 404) return null
      throw err
    }
  }

  async getCalendar(): Promise<BgmCalendarItem[]> {
    const url = `${BGM_BASE}/calendar`
    return this.fetchJson(url, { headers: this.headers(), signal: AbortSignal.timeout(30000) })
  }

  async downloadImage(url: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
    const normalizedUrl = url.startsWith('//') ? `https:${url}` : url
    let res: Response
    try {
      res = await fetch(normalizedUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
    } catch {
      return null
    }
    if (!res.ok) return null
    return {
      data: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') || 'image/jpeg',
    }
  }

  async oauthAccessToken(clientId: string, clientSecret: string, code: string, redirectUri: string) {
    const url = `https://bgm.tv/oauth/access_token`
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(30000),
    }) as Promise<{ access_token: string; refresh_token: string; user_id: number }>
  }

  async refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<{ access_token: string; refresh_token: string; user_id: number }> {
    const url = `https://bgm.tv/oauth/access_token`
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(30000),
    }) as Promise<{ access_token: string; refresh_token: string; user_id: number }>
  }

  /**
   * 查询 access token 状态（POST /oauth/token_status）。
   * 返回 token 是否有效及其过期 unix 时间戳；无效时 valid=false。
   * 这是唯一能可靠区分「token 过期(401)」与「资源不存在(404)」的探测方式。
   */
  async tokenStatus(token: string): Promise<TokenStatus> {
    const url = `https://bgm.tv/oauth/token_status`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: new URLSearchParams({ access_token: token }).toString(),
        signal: AbortSignal.timeout(30000),
      })
    } catch {
      return { status: 'probe_failed' }
    }
    if (res.status === 401 || res.status === 403) return { status: 'invalid' }
    if (res.status >= 500) return { status: 'probe_failed' }
    if (!res.ok) return { status: 'probe_failed' }
    try {
      const data = (await res.json()) as { valid?: boolean; expires?: number }
      if (data.valid === true && typeof data.expires === 'number') {
        return { status: 'valid', expires: data.expires }
      }
      return { status: 'invalid' }
    } catch {
      return { status: 'invalid' }
    }
  }

  async patchCollection(token: string, subjectId: number, body: Record<string, unknown>) {
    const url = `${BGM_BASE}/v0/users/-/collections/${subjectId}`
    return this.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  }

  async upsertCollection(token: string, subjectId: number, body: Record<string, unknown>) {
    const url = `${BGM_BASE}/v0/users/-/collections/${subjectId}`
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  }

  async getSubjectEpisodeCollections(token: string, subjectId: number): Promise<{ data: BgmEpisodeCollection[]; total: number }> {
    const url = `${BGM_BASE}/v0/users/-/collections/${subjectId}/episodes?limit=1000&offset=0`
    return this.fetchJson(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
      signal: AbortSignal.timeout(30000),
    })
  }

  async patchSubjectEpisodeCollections(token: string, subjectId: number, episodeIds: number[], type: 0 | 1 | 2 | 3) {
    const url = `${BGM_BASE}/v0/users/-/collections/${subjectId}/episodes`
    return this.fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': UA },
      body: JSON.stringify({ episode_id: episodeIds, type }),
      signal: AbortSignal.timeout(30000),
    })
  }

  /** 用 access token 换取当前用户信息（username, id 等）。 */
  async getMe(token: string): Promise<{ username: string; id: number }> {
    const res = await fetch('https://api.bgm.tv/v0/me', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      throw new BgmHttpError(res.status, `bgm.tv getMe: ${res.status}`)
    }
    return res.json()
  }
}
