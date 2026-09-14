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

## 规范化 authority

`PostgresAuthority` 接收通过 `DATABASE_URL` 创建的 `pg.Pool` 和运行时 secret 值列表。`0001_initial.sql` 创建 `users`、`subjects`、`collection_items`、`subject_media`、`calendar_entries`、`sync_runs`、`publications`。这是尚未部署的初始 migration；若开发数据库已应用旧占位版本，checksum 校验会拒绝它，测试应使用新的 disposable schema，不能修改数据库中的 checksum 绕过校验。

`beginRun` 记录 run identity、source、mode、git SHA 和 Unix 秒观察时间。`commitCompleteState` 接受全部配置用户的完整结果和完整日历；用户缺失、重复 subject、重复收藏、非法日历或 incomplete 标记均会拒绝写入。调用方先完成分页与 upstream contract 校验，再提交已归一化数据。事务用 advisory lock 串行化，subjects/collections 的 upsert、日历替换及 run checkpoint 一起提交或回滚；事务期间仅访问 PostgreSQL。

收藏使用 `(user_id, subject_id)` 主键。第一次完整缺失观察记录 `missing_since`，只有更晚的一次完整缺失观察才写 `deleted_at`；同一个 run 重放不会推进删除。重新观察到条目会清除两个标记。顺序与 `packages/domain/src/collection-diff.ts` 的规则一致，没有独立缺失次数计数器。

`listDueMedia` 按重试/刷新时间、subject ID 返回到期候选。`applyMediaResult` 用 subject 行锁和 `(observed_at, run_id)` 栅栏拒绝旧结果；时间相同时 run ID 使用固定字典序。调用方应复用已注册 run 的观察时间。失败或 404 保留最近成功的 detail/image 引用，记录重试或 tombstone 时间；成功结果只能写入与 hash 一致的 `images/<hash>/original` 或 `shadow/images/<hash>/original` 引用。

`publications` 只允许一行，内含 verified 与至多一个 pending。`savePendingPublication` 只接受下一代 generation；精确候选支持 replay，未被 claim 的候选允许由更新观察替换。`claim`/`release` 必须使用同一完整候选；`verifyPublication` 仅提升已 claim 且身份一致的 pending，已验证候选可幂等重放。相同 verified hash 返回 `no_change`，只清理未 claim 且不晚于当前观察的 pending。这里的 object key 是不带部署命名空间的逻辑 key；外部发布调用方负责选择 live/shadow 命名空间。

## Secret 禁存与测试

数据库只保存明确列出的业务字段；额外 upstream 属性、raw response、authorization、token、webhook 和连接配置不写入 JSON。初始化 authority 时必须传入运行时凭据值列表，所有可持久化自由文本/JSON 都会检查这些值；发现匹配即在写入前拒绝。通用 PostgreSQL URL、Bearer header、带密码 URL 也会被拒绝。错误持久化只接受稳定类别，未知错误映射为 `UNKNOWN`，不会存异常消息。`finishRun` 通过固定字段记录终态、组件结果、媒体计数与阶段耗时；通知结果可更新，但不能改写已结束 run 的业务状态、publication 或 backup 结果。

仓储测试沿用 `VPS_SYNC_TEST_DATABASE=1` 与 disposable `DATABASE_URL`。运行包测试会同时覆盖 migration 与 repository；CI 的 PostgreSQL 17 service 已启用上述变量。数据库断言包括完整 rollback、两次缺失/恢复、媒体 fence、publication pending/replay/claim/generation 冲突，以及遍历测试 schema 所有 text/json 列的 secret 扫描。缺少本地数据库时这些断言明确标记 skipped，不能以单元测试通过替代。
