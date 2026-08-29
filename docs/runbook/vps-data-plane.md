# VPS 数据平面运行手册

## PostgreSQL migration 前置条件

`apps/vps-sync` 仅使用标准 TLS `DATABASE_URL` 连接 PostgreSQL。迁移运行器在开始业务同步前执行，并以独立 PostgreSQL session advisory lock 串行化；未获得该锁会失败退出，不能继续业务写入。

## PostgreSQL authority 写入边界

`PostgresAuthority` 是 VPS 运行时对 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs` 与 `publications` 的唯一写入边界。所有业务数据都通过参数化 SQL 传入；不得把 access/refresh token、数据库 URL、webhook URL/secret、R2 credentials、原始 authorization header 或未脱敏上游响应写进 text 或 JSON 列。

完整 collection/calendar 观察在单个数据库事务中提交：先 upsert 当前 users、subjects 与 collection items，再记录缺失观察、替换 calendar，最后 checkpoint run。事务内不得发生上游、R2 或其他网络调用。对同一 `(user_id, subject_id)`，首次完整缺失只设置 `missing_since` 和 `missing_run_id`；只有另一个成功 run 的第二次完整缺失才设置 `deleted_at`。重新观察到条目会清除所有 missing/deleted 状态。

`subject_media` 同时保存 `observed_at` 与 `observed_run_id` fence。较旧的 observation 不得覆盖 last-known-good detail、metadata 或 image references。publication 只有一个 verified state 和至多一个 pending state：完全相同的 pending 可 replay，只有未 claim 的 pending 才能由同 generation 替换；verified promotion 必须匹配 pending 的 generation、hash 与 object key，并且只能前进一步。

迁移集成验证需要 PostgreSQL 17。Docker 可用的环境可以启动一次性实例：

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
```

随后将 `DATABASE_URL` 指向该实例并运行迁移测试。CI 应使用带 health check 的 `postgres:17-alpine` service；测试结束后销毁该实例。本机未安装 Docker CLI 时，该真实 PostgreSQL 验证是环境前置条件，不得以 SQL mock 替代上线前集成门禁。

## 不可逆策略与回退

SQL migrations 仅可向前应用。`schema_migrations` 保存 migration 文件名、SHA-256 checksum 和应用时间；任何已应用 migration 的 checksum 改变都会以 `MIGRATION_CHECKSUM_MISMATCH` 终止。数据库出现当前镜像不认识的已应用 migration 时，以 `MIGRATION_SCHEMA_AHEAD` 终止。

回退应部署仍兼容当前 schema 的已知镜像，或恢复经验证的数据库备份；不得反向执行 migration，也不得删除已应用 migration 记录。
