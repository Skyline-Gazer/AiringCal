# VPS 数据平面运行手册

## PostgreSQL migration

`@airing-cal/vps-sync` 使用标准 `DATABASE_URL` 连接 PostgreSQL。migration 按文件名顺序前向执行；已记录 migration 的 SHA-256 必须与 SQL 文件一致。发现 checksum 不一致、数据库包含应用不认识的 migration，或 migration 历史缺口时会拒绝继续。migration 不提供回滚或删除已应用 schema 的操作。

集成测试只对 disposable PostgreSQL 执行。先在独立终端启动 PostgreSQL 17：

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 54329:5432 postgres:17-alpine
```

随后设置测试专用连接与显式开关；测试会创建并删除随机 schema，不会使用默认 schema：

```sh
DATABASE_URL=postgres://postgres:test@127.0.0.1:54329/postgres VPS_SYNC_TEST_DATABASE=1 pnpm -F @airing-cal/vps-sync test -- src/postgres/migrate.test.ts
```

未配置 disposable PostgreSQL 或 `VPS_SYNC_TEST_DATABASE=1` 时，迁移集成测试会跳过。Docker 缺失不是跳过 checksum/advisory-lock 集成门槛的理由；请在具备该前置条件的 CI 或开发环境执行。
