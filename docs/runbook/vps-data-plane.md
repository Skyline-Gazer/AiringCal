# VPS 数据平面运行手册

## PostgreSQL migration 前置条件

`apps/vps-sync` 仅使用标准 TLS `DATABASE_URL` 连接 PostgreSQL。迁移运行器在开始业务同步前执行，并以独立 PostgreSQL session advisory lock 串行化；未获得该锁会失败退出，不能继续业务写入。

迁移集成验证需要 PostgreSQL 17。Docker 可用的环境可以启动一次性实例：

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
```

随后将 `DATABASE_URL` 指向该实例并运行迁移测试。CI 应使用带 health check 的 `postgres:17-alpine` service；测试结束后销毁该实例。本机未安装 Docker CLI 时，该真实 PostgreSQL 验证是环境前置条件，不得以 SQL mock 替代上线前集成门禁。

## 不可逆策略与回退

SQL migrations 仅可向前应用。`schema_migrations` 保存 migration 文件名、SHA-256 checksum 和应用时间；任何已应用 migration 的 checksum 改变都会以 `MIGRATION_CHECKSUM_MISMATCH` 终止。数据库出现当前镜像不认识的已应用 migration 时，以 `MIGRATION_SCHEMA_AHEAD` 终止。

回退应部署仍兼容当前 schema 的已知镜像，或恢复经验证的数据库备份；不得反向执行 migration，也不得删除已应用 migration 记录。
