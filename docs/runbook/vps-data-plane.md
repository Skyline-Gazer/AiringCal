# VPS 数据平面运行手册

## PostgreSQL migration 前置条件

`apps/vps-sync` 仅使用标准 TLS `DATABASE_URL` 连接 PostgreSQL。迁移运行器在开始业务同步前执行，并以独立 PostgreSQL session advisory lock 串行化；未获得该锁会失败退出，不能继续业务写入。

## PostgreSQL authority 写入边界

`PostgresAuthority` 是 VPS 运行时对 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs` 与 `publications` 的唯一写入边界。构造 authority 时必须提供非空的 runtime secret 列表作为 persistence guard；调用方不得静默省略该列表。所有业务数据都通过参数化 SQL 和封闭的 normalized DTO 传入；repository 会在发起 query 前递归验证所有 JSON projection 的精确 nested keys、标量/枚举类型、有限数值和数组元素，而不依赖 TypeScript structural type。access/refresh token、数据库 URL、webhook URL/secret、R2 credentials、原始 authorization header、raw error/response shape 或未脱敏上游响应不得进入任何 text/JSON 列。

完整 collection/calendar 观察在单个数据库事务中提交：先建立 collection 与 calendar-only 条目共同引用的规范化 subject，再复用 domain `planCollectionDiff` 只持久化 inserts、真实 updates、first-missing、confirmed-deleted 与 restored 集合，随后替换 calendar 并 checkpoint run。事务内不得发生上游、R2 或其他网络调用。对同一 `(user_id, subject_id)`，首次完整缺失只设置 `missing_since` 和追踪用 `missing_run_id`；只有 `observed_at > missing_since` 的后续完整观察才设置 `deleted_at`，run identity 不参与确认判断。同一 run 的更晚观察可以确认删除，不同 run 的相同或更旧观察不能确认；重新观察到条目会清除 missing/deleted 状态。subject/collection 内容未改变时不执行对应写入。

`subject_media` 同时保存 `observed_at` 与 `observed_run_id` fence。较旧的 observation 不得覆盖 last-known-good detail、metadata 或 image references。publication 只有一个 verified state 和至多一个 pending state：`savePendingPublication` 只保存 unclaimed candidate，`claimPendingPublication` 以 generation/hash/key/run identity 做条件 claim，exact replay 必须复用相同的 persisted `claimed_at` identity；`clearUnclaimedPending` 只在 verified generation/hash 仍与 no-change caller 一致时清除 unclaimed pending。claimed pending 不可替换或被 no-change cleanup 清除；verified promotion 必须匹配 pending 的 generation、hash、object key、run 与 `claimed_at`，未 claim、wrong-run 或 wrong-claim caller 均不得 promotion，并且 generation 只能前进一步。

迁移集成验证需要 PostgreSQL 17。Docker 可用的环境可以启动一次性实例：

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
```

随后将 `DATABASE_URL` 指向该实例并运行 fail-closed 门禁：

```sh
pnpm -F @airing-cal/vps-sync test:integration
```

该 suite 会创建随机隔离 schema，真实执行 immutable `0001` → current migration、checksum/current-schema gate、session advisory lock、事务 rollback、calendar-only foreign key、canonical 删除/恢复与 unchanged-zero-write、media stale fence、publication claim/cleanup CAS，并扫描所有 text/JSON 列。未配置 `DATABASE_URL` 时命令必须以 `DATABASE_URL_REQUIRED_FOR_POSTGRES_INTEGRATION` 失败，不得 skip 或以 recording fake 冒充通过。CI 应使用带 health check 的 `postgres:17-alpine` service；测试结束后 suite 删除其随机 schema 并关闭 pool。本机未安装 Docker CLI 时，该真实 PostgreSQL 验证是环境前置条件。

## 不可逆策略与回退

SQL migrations 仅可向前应用。已发布的 `0001_initial.sql` 固定为 Task 1.1 commit `a55b17718387c83067c4e1f7a34bd4d6d049d10f` 的逐字节内容（SHA-256 `cd06c6a655aee9762095de384407e584a2340ad9b7a5a17b027adb966337486f`）；run observation fences 从 `0002_authority_constraints.sql` 起追加，禁止重写 `0001`。`schema_migrations` 保存 migration 文件名、SHA-256 checksum 和应用时间；任何已应用 migration 的 checksum 改变都会以 `MIGRATION_CHECKSUM_MISMATCH` 终止，非有序前缀历史以 `MIGRATION_HISTORY_GAP` 终止，数据库出现当前镜像不认识的 migration 时以 `MIGRATION_SCHEMA_AHEAD` 终止。migration 命令只从合法前缀应用尾部；业务启动必须调用 `assertCurrentSchema`，schema behind 或 ahead 均不得继续业务工作。

回退应部署仍兼容当前 schema 的已知镜像，或恢复经验证的数据库备份；不得反向执行 migration，也不得删除已应用 migration 记录。
