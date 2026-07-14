# Platform Abstraction Design

> 状态：待审核 | 日期：2026-06-25

## 目标

为后续多平台支持（MyAnimeList 等）做架构预埋。将当前硬编码 bgm.tv 的同步/对比管线抽象为平台无关接口，后续加平台只需实现接口、不碰现有逻辑。

## 非目标

- 不实现 MAL 或其他平台的 API 客户端
- 不改动 cron sync 主流程（`runSync`）——它只处理 bgm.tv 数据并写入 KV 快照
- 不改动前端展示（番组计划/放送日历视图）

---

## 架构

### 1. `PlatformClient` 接口

**文件：** `packages/shared/src/platform/client.ts`（新建）

```typescript
export type PlatformId = 'bgm' | 'mal'

/** 平台无关的收藏条目，用于对比 */
export interface ComparisonItem {
  externalId: string       // 平台内部 subject_id
  title: string            // name_cn || name
  status: WatchStatus      // 标准化状态
  progress: number         // ep_status，当前话数
  totalEpisodes: number    // eps || total_episodes || 0
  score: number            // rate，1-10
}

export interface AccountInfo {
  username: string
  externalId: string
  platform: PlatformId
}

/** 平台的 API 客户端必须实现此接口 */
export interface PlatformClient {
  readonly platform: PlatformId

  /** 用 token 获取账户信息 */
  getMe(token: string): Promise<AccountInfo>

  /** 拉取账户的所有收藏，返回标准化条目列表 */
  fetchCollections(token: string, username: string): Promise<ComparisonItem[]>

  /** 向目标账户写入单个条目的收藏状态 */
  patchEntry(token: string, externalId: string, item: ComparisonItem): Promise<void>
}
```

### 2. `BgmClient` 实现接口

**文件：** `packages/shared/src/platform/bgm.ts`（新建）

将现有 `BgmClient` 中用于 compare/sync 的方法封装为实现 `PlatformClient` 的适配器：

- `getMe()` → 已有，返回 `{ username, id }`
- `fetchCollections()` → 封装 `fetchAllCollections`，返回 `ComparisonItem[]`，含 BGM 状态码 → `WatchStatus` 的映射
- `patchEntry()` → 封装 `patchCollection`，将 `ComparisonItem` 反规范化为 bgm.tv API body

**BGM 状态映射（写死在适配器内）：**
```
1 (想看) → PLAN_TO_WATCH
2 (看过) → COMPLETED
3 (在看) → WATCHING
4 (搁置) → ON_HOLD
5 (抛弃) → DROPPED
```

### 3. 通用 `WatchStatus` 枚举

```typescript
export enum WatchStatus {
  WATCHING = 'watching',
  COMPLETED = 'completed',
  PLAN_TO_WATCH = 'plan_to_watch',
  ON_HOLD = 'on_hold',
  DROPPED = 'dropped',
}
```

### 4. 文件结构变更

```
packages/shared/src/
  platform/
    client.ts          # PlatformClient 接口 + ComparisonItem + WatchStatus
    bgm.ts             # BgmPlatformClient implements PlatformClient
    index.ts           # re-export
  bgm-client.ts        # 保留，cron sync 等其他模块仍然直接使用
```

### 5. compare.ts 抽象化

当前 `compareAccounts()` 直接使用 `BgmClient` 和 `BgmCollection`。改为：

```typescript
export async function compareAccounts(
  clientA: PlatformClient, tokenA: string,
  clientB: PlatformClient, tokenB: string,
): Promise<CompareResult>
```

`compareAccounts` 不再关心平台，只操作 `ComparisonItem[]`。平台相关的拉取和映射在调用方完成。

### 6. sync-write.ts 抽象化

当前 `executeSync()` 直接调用 `BgmClient.patchCollection()`。改为：

```typescript
export async function executeSync(
  clientA: PlatformClient, fromToken: string,
  clientB: PlatformClient, toToken: string,
  request: SyncRequest,
  env?: { SYNCLOCK: DurableObjectNamespace },
): Promise<SyncResult[]>
```

### 7. API 端点适配

`POST /api/manage/compare` 和 `POST /api/manage/sync` 接受新增 `platform` 字段（默认 `'bgm'`），后端根据 `platform` 选择对应的 `PlatformClient` 实现。

```typescript
function getPlatformClient(platform: PlatformId): PlatformClient {
  switch (platform) {
    case 'bgm': return new BgmPlatformClient()
    case 'mal': return new MalPlatformClient() // 后续实现
  }
}
```

### 8. UI 预埋

两个 token 输入旁各加一个平台选择器 `<select>`：
- 选项：`bgm.tv`（默认）
- 后续加 `MyAnimeList`
- 请求体中携带 `platformA` / `platformB` 字段

---

## 不变部分

以下模块保持不动，后续也不需要动：

| 模块 | 原因 |
|------|------|
| `cron.ts` / `runSync()` | 只处理 bgm.tv → KV 快照，与用户交互无关 |
| `merger.ts` | 收藏合并逻辑与平台无关，已在 `MergedEntry` 层操作 |
| `image/download.ts` | 图片下载管线独立 |
| `image/proxy.ts` | 图片代理独立 |
| `sync-lock.ts` | DO 互斥锁与平台无关 |
| 前端收藏/日历视图 | 从 KV 读取，不受 compare/sync 管线影响 |

---

## 自检

- [x] 无 placeholder / TODO
- [x] 接口定义完整，有字段和类型
- [x] 文件路径明确
- [x] 不变部分列出
- [x] 状态映射写死，无歧义
