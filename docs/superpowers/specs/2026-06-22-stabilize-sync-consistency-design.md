---
comet_change: stabilize-sync-consistency
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

# Design Doc: 同步稳定性加固

## 1. 设计目标

将当前无并发保护的 Cron/手动同步流程加固为可靠的单执行管线，并修复主账户失败静默降级、Token 状态误判等隐藏缺陷。快照改为统一版本化 key，为后续数据新鲜度与审计提供基础。

### 1.1 范围

- **同步互斥**：新增 SyncLock Durable Object 实现全局互斥
- **快照合并**：`collections:merged` + `calendar` 合并为单 `sync:snapshot` key
- **旧 key 兼容**：1-2 周内 `sync:snapshot` 缺失时回退读取旧 key
- **Primary 保护**：primary 模式下主账户失败不写快照
- **Token 三态**：tokenStatus 区分 valid / invalid / probe_failed
- **错误结构化**：`sync:last_error` 升级为结构化对象

### 1.2 非目标

- 不引入 D1 或外部持久化加锁
- 不修改 bgm.tv API 客户端签名（tokenStatus 返回值类型扩展除外）
- 不修改 `/api/collections` 和 `/api/calendar` 的 HTTP 响应 schema

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 2. 架构变更

### 2.1 SyncLock Durable Object

```
POST /__cron/sync ─────┐
scheduled (Cron) ──────┤  acquireLock()
POST /api/manage/sync ─┘       │
                                ▼
                         SyncLock DO
                         (唯一实例)
                         ┌──────────────┐
                         │ locked: bool  │
                         │ expires_at   │
                         │ alarm (5min) │
                         └──────────────┘
                                │
                         runSync / executeSync
                                │
                         releaseLock()
```

#### 接口

```typescript
interface SyncLock {
  // 获取锁。已锁且未过期 → 拒绝；否则加锁 + 设 alarm
  acquire(ttlSeconds?: number): Promise<{ acquired: boolean }>
  // 释放锁 + 清除 alarm
  release(): Promise<void>
  // 强制释放（alarm 超时触发，仅 DO 内部调用）
  forceRelease(): Promise<void>
}
```

#### 关键行为

| 场景 | 行为 |
|------|------|
| 无锁 | 加锁，设 300s alarm，返回 `{ acquired: true }` |
| 有锁且未过期 | 返回 `{ acquired: false }` |
| 有锁但已过期 | 视为 dead lock，覆盖加锁 |
| alarm 触发 | DO 自动调用 `forceRelease()` 解锁 |
| Worker 崩溃 | alarm 5 分钟后自动释放 |

#### 调用方错误映射

| 调用方 | 获取锁失败 | HTTP 状态 |
|--------|-----------|----------|
| Cron 触发 (`scheduled`) | 跳过本次执行 | - |
| HTTP 触发 (`POST /__cron/sync`) | 返回错误 | 409 Conflict |
| 管理端 (`POST /api/manage/sync`) | 返回错误 | 423 Locked |

### 2.2 快照合并

#### KV Key 迁移

```
之前:
  collections:merged  → MergedCollections
  calendar            → BgmCalendarItem[]

之后:
  sync:snapshot       → SyncSnapshot
```

#### SyncSnapshot 结构

```typescript
interface SyncSnapshot {
  collections: MergedCollections
  calendar: BgmCalendarItem[]
  meta: SyncSnapshotMeta
}

interface SyncSnapshotMeta {
  synced_at: number    // Unix 秒级时间戳（快照生成时间）
  mode: 'merge' | 'primary'
  primary_user?: string
  generation: number   // 单调递增，从 1 开始
}
```

#### 写入语义

- **仅完整成功才写**：收藏拉取 + 日历拉取 + merge 均成功后一次性 `kv.put('sync:snapshot', snapshot)`
- KV put 是原子的，不存在半更新
- `generation` 每次同步成功自增，用于审计和缓存失效
- 失败不 touch `sync:snapshot`

### 2.3 兼容读取

`/api/collections` 和 `/api/calendar` 的 handler 改为通过统一读取函数获取快照：

```typescript
async function getSnapshot(kv: KVStorage): Promise<SyncSnapshot | null> {
  const snap = await kv.get<SyncSnapshot>('sync:snapshot')
  if (snap) return snap

  // 旧 key 回退（1-2 周后移除）
  const collections = await kv.get<MergedCollections>('collections:merged')
  const calendar = await kv.get<BgmCalendarItem[]>('calendar') ?? []
  if (collections) {
    return {
      collections,
      calendar,
      meta: { synced_at: 0, mode: 'merge', generation: 0 }
    }
  }
  return null
}
```

- `generation: 0` 标记为旧格式回退，方便监控
- `synced_at: 0` 表示未知同步时间
- 1-2 周后删除旧 key 回退分支，只保留 `sync:snapshot` 读取

### 2.4 Primary 主账户失败保护

```typescript
// cron.ts: runSync() 内
const results = await Promise.allSettled(
  users.map(u => fetchAllCollections(client, u))
)

if (mode === 'primary') {
  const idx = users.indexOf(primaryUser)
  const result = results[idx as number]
  if (!result || result.status === 'rejected') {
    throw new Error(`Primary user (${primaryUser}) fetch failed; aborting sync`)
  }
  // result.status === 'fulfilled' 但数据可能为空
  if (result.value.length === 0) {
    throw new Error(`Primary user (${primaryUser}) returned empty collections; aborting sync`)
  }
  merged = primaryMerge(result.value)
} else {
  merged = merge(allCollectionsWhereFulfilled(results))
}
```

### 2.5 Token 三态探测

#### 当前行为（二态）

所有非 2xx 或网络异常 → `{ valid: false }`，不可区分 token 真正无效和 bgm.tv 临时故障。

#### 新行为（三态）

```typescript
type TokenStatus =
  | { status: 'valid'; expires: number }
  | { status: 'invalid' }
  | { status: 'probe_failed' }
```

| HTTP 响应 | 返回 |
|-----------|------|
| 2xx + `{ valid: true }` | `{ status: 'valid', expires }` |
| 2xx + 其他 / JSON 解析失败 | `{ status: 'invalid' }` |
| 401 / 403 | `{ status: 'invalid' }` |
| 5xx / 网络异常 | `{ status: 'probe_failed' }` |

#### ensureFreshToken 决策表

| tokenStatus | access_token 过期在即？ | 操作 |
|-------------|----------------------|------|
| `valid` | 否 | 无需刷新 |
| `valid` | 是（< 1h） | 调用 refreshAccessToken() |
| `invalid` | - | 调用 refreshAccessToken() |
| `probe_failed` | - | 放弃本次同步，不消费 refresh_token |

### 2.6 错误报告结构化

```typescript
interface SyncErrorLog {
  timestamp: number
  error: string
  stage: 'token_refresh' | 'fetch_collections' | 'fetch_calendar' | 'write_snapshot' | 'lock_timeout'
}
```

写入 KV key `sync:last_error`（替代旧版纯字符串）。

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 3. 数据流

### 3.1 同步流程（加固后）

```
acquireLock()
   ├─ 失败 → 返回 409/423 / 跳过
   └─ 成功
       ├─ ensureFreshToken()
       │    ├─ tokenStatus = 'valid' + 未过期 → 使用当前 token
       │    ├─ tokenStatus = 'valid' + 临期 → refreshAccessToken()
       │    ├─ tokenStatus = 'invalid' → refreshAccessToken()
       │    └─ tokenStatus = 'probe_failed' → 放弃，记录 sync:last_error，return
       │
       ├─ fetchAllCollections(all users)
       │    ├─ Primary 模式：检查主账户 result
       │    │    ├─ fulfilled + 非空 → 继续
       │    │    └─ rejected / 空 → 放弃，记录 sync:last_error，return
       │    └─ Merge 模式：merge(所有成功的)
       │
       ├─ getCalendar()
       │    ├─ 成功 → 继续
       │    └─ 失败 → 放弃，记录 sync:last_error（不写快照），return
       │
       ├─ KV.put('sync:snapshot', { collections, calendar, meta })
       │    └─ 写入 sync:last_success
       │
       └─ releaseLock()
```

### 3.2 首次部署迁移

```
首次部署后首次 Cron 触发:
  1. acquireLock()
  2. ensureFreshToken()
  3. fetchAllCollections + merge
  4. getCalendar()
  5. KV.put('sync:snapshot', { ... })
  6. releaseLock()

API 读取路径自动切换:
  sync:snapshot 有数据 → 直接返回（generation >= 1）
  旧格式读取仅在新快照为空时触发

旧 key (collections:merged / calendar):
  不再写入
  1-2 周后手动删除
```

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 4. 文件影响面

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `packages/worker/src/index.ts` | MODIFY | 注册 SyncLock DO binding；scheduled 和 /__cron/sync 加锁；API handler 改用 getSnapshot() |
| `packages/worker/src/cron.ts` | REWRITE | 重构 runSync()：加锁/解锁、primary 保护、快照写入、结构化错误 |
| `packages/shared/src/bgm-client.ts` | MODIFY | tokenStatus() 返回三态 |
| `packages/worker/src/api/collections.ts` | MODIFY | 改用 getSnapshot() 读取 |
| `packages/worker/src/api/calendar.ts` | MODIFY | 改用 getSnapshot() 读取 |
| `packages/worker/src/manage/sync-write.ts` | MODIFY | 加锁/解锁；输入校验提前 |
| `packages/worker/src/sync-lock.ts` | **NEW** | SyncLock Durable Object |
| `wrangler.toml` / `wrangler.jsonc` | MODIFY | DO binding 配置 |
| `packages/worker/src/storage/kv.ts` | MODIFY | 可选：新增 getSnapshot() 便捷方法 |

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 5. 测试策略

### 5.1 单元测试

| 被测单元 | 文件 | 优先级 | 覆盖点 |
|---------|------|--------|--------|
| `tokenStatus()` | bgm-client.test.ts | P0 | 2xx valid / 2xx invalid / 401 / 403 / 5xx / network-error → 三态 |
| `ensureFreshToken()` | cron.test.ts | P0 | valid+不刷新 / valid+临期刷新 / invalid→刷新 / probe_failed→放弃 |
| `runSync()` primary 失败 | cron.test.ts | P0 | 主账户 rejected → 不写快照；主账户空 → 不写快照 |
| `runSync()` 日历失败 | cron.test.ts | P0 | 日历抛错 → 不写快照，error stage=calendar |
| `getSnapshot()` | kv.test.ts | P0 | 新快照命中 → 直接返回；旧 key 回退 → generation=0 |
| SyncLock DO | sync-lock.test.ts | P1 | acquire→release / 并发拒绝 / alarm 过期自动释放 |
| `executeSync()` 校验 | sync-write.test.ts | P1 | 非法模式/空用户名/无效 token → 400，不调 bgm.tv |

### 5.2 集成测试（后续）

- Cloudflare Miniflare 本地模拟 DO + KV 的完整同步流程
- 模拟 bgm.tv API 的网络故障场景

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| DO alarm 5min 过期，超长同步 >5min 导致锁提前释放 | 低 | 中 | 当前数据量远达不到；如未来需要可调大 ttl 或动态续期 |
| 首次部署时旧 key 回退读到脏数据 | 低 | 低 | 旧 key 在最后一次 Cron 写入后不再更新；API 返回数据一致，只是稍旧 |
| refresh_token 被并发消费（锁外的极端竞态） | 极低 | 中 | 全局锁覆盖所有 token 操作路径；仅锁实现 bug 才可能 |
| DO 冷启动延迟导致锁获取变慢 | 中 | 低 | 首次请求 DO 冷启动 ~100ms；后续热实例无延迟；同步本就是后台任务 |

archived-with: 2026-06-22-stabilize-sync-consistency
status: final
---

## 7. 部署注意事项

1. **DO 配置**：在 wrangler.toml 添加 `[[durable_objects.bindings]]` 和 `[[migrations]]`，class_name = `SyncLock`
2. **Env 兼容**：现有 `SYNC_MODE`、`BANGUMI_USERS`、`BANGUMI_PRIMARY_USER`、`BANGUMI_TOKEN` 等 env 变量不变
3. **灰度**：本地 Miniflare 测试通过后直接部署；回滚只需恢复旧代码，旧 key 仍在
4. **旧 key 清理**：部署 1-2 周后，确认无问题，提交一个小 tweak 删除兼容回退分支 + 手动删除旧 KV key
