import { BgmClient, type BgmCollection } from './bgm-client.ts'

export interface FetchAllCollectionsOptions {
  now?: () => number
  budgetMs?: number
}

export async function fetchAllCollections(client: BgmClient, username: string, options: FetchAllCollectionsOptions = {}): Promise<BgmCollection[]> {
  const all: BgmCollection[] = []
  const limit = 50
  const now = options.now ?? Date.now
  const budgetMs = options.budgetMs ?? 120_000
  const deadline = now() + budgetMs

  const assertBudget = () => {
    if (now() > deadline) throw new Error('获取收藏超过 120s 总预算')
  }

  try {
    assertBudget()
    const first = await client.getCollections(username, 0, limit)
    const total = first.total
    if (total === 0) return []
    all.push(...first.data)

    const pages = Math.ceil(total / limit)
    let offset = limit

    for (let p = 1; p < pages; p++) {
      assertBudget()
      const { data } = await client.getCollections(username, offset, limit)
      all.push(...data)
      offset += limit
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`获取用户 ${username} 的收藏时失败：${msg}`, { cause: err })
  }

  return all
}
