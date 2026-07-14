# Brainstorm Summary

- Change: stabilize-sync-consistency
- Date: 2026-06-22

## 确认的技术方案

### 全局互斥 — SyncLock Durable Object
- 新增 `SyncLock` DO，单实例维护 `{ locked, expires_at }`
- `acquireLock(ttl=300s)`：已锁且未过期 → 拒绝；否则加锁 + 设 alarm
- `releaseLock()`：主动释放 + 清除 alarm
- alarm 5 分钟过期自动释放，防死锁
- Cron 触发被拒返回 409，管理端被拒返回 423

### 快照 — 单 key 扁平对象
- KV key: `sync:snapshot`，替代旧的 `collections:merged` + `calendar`
- 结构：`{ collections: MergedCollections, calendar: BgmCalendarItem[], meta: { synced_at, mode, primary_user?, generation } }`
- 只有完整同步成功后才写入；KV 原子写保证不会半更新
- generation 从 1 起单调递增
- `/api/collections` 和 `/api/calendar` 从快照中取对应字段

### 旧 key 兼容回退 — 1-2 周
- 读取 `sync:snapshot`，未命中时回退读旧 key
- 回退期间 generation=0，方便区分
- 1-2 周后移除回退逻辑

### Primary 主账户失败保护
- primary 模式下单独检查主账户的 `PromiseSettledResult`
- fulfilled + 数据非空 → 继续；rejected 或数据为空 → 抛错，不写快照

### Token 状态三态区分
- `BgmClient.tokenStatus()` 按 HTTP 状态码区分：
  - 2xx + valid=true → `{ status: 'valid', expires }`
  - 401/403 → `{ status: 'invalid' }`
  - 5xx / 网络异常 → `{ status: 'probe_failed' }`
- `ensureFreshToken()` 仅在 `invalid` 或 `valid-but-expiring` 时刷新
- `probe_failed` → 放弃本次同步，不消费 refresh token

### 管理端同步
- `executeSync()` 走全局锁，与 Cron 互斥
- 输入校验提前：模式、用户名、token 格式

### 错误报告结构化
- `sync:last_error` 升级为 `{ timestamp, error, stage }`
- stage 枚举：token_refresh | fetch_collections | fetch_calendar | write_snapshot | lock_timeout

## 关键取舍与风险

- **取舍**：选择了 DO 而非 D1 锁（项目无 D1），增加一个 DO 配置但实现最简
- **取舍**：选择了中期兼容而非短期，多维护一段回退代码但安全窗口更宽
- **风险**：DO alarm 5 分钟过期，若单次同步超过 5 分钟锁会自动释放。当前 bgm.tv 数据量不会超过，但如果未来数据暴涨需要调大 ttl
- **风险**：首版迁移期间旧 key 回退 + 新快照同时存在，两个数据源可能短暂不一致（旧 key 在迁移前最后一次写入后就不再更新）

## 测试策略

| 组件 | 测试优先级 |
|------|-----------|
| `ensureFreshToken()` 三态决策 | P0 |
| `runSync()` primary 失败不写快照 | P0 |
| `runSync()` 日历失败不写快照 | P0 |
| 快照读写 + 旧 key 回退 | P0 |
| SyncLock DO 加锁/解锁/过期/拒绝 | P1 |
| `executeSync()` 输入校验 | P1 |
| `tokenStatus()` HTTP 状态码映射 | P1 |

## Spec Patch

无。当前 delta spec 的 6 个 Requirement 和对应 Scenario 覆盖了本设计的核心行为，无需补充验收场景。
