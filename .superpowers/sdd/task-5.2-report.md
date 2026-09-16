# Task 5.2 报告：备份保留与安全恢复校验

## 状态

DONE_WITH_CONCERNS — `runOnce` 的注入式 backup composition、纯保留候选选择和安全 restore verification 已实现并通过单元/类型/构建验证。当前工作机没有容器 runtime，无法直接在 `postgres:17-alpine` 目标镜像内执行 `pg_restore --help` 或真实恢复演练；已按任务要求用 PostgreSQL 17 官方文档、源码和镜像构建配方完成只读核验（见下文）。本任务没有启用 executable `sync`/restore 命令、生产调度、生产数据库/R2 操作或 R2 删除。

## 实现

- `apps/vps-sync/src/cli.ts` 导出 `runOnceWithBackup` 注入式 composition。调用方必须提供真实 `notify` port 和 `backupConfig`；composition 使用已实现的 `createBackup`，沿用 `runOnce` 仅在 `published` / `no_change` 后执行 backup、backup 失败转 `partial` 且保留 publication 的语义。没有注册 executable `sync` 命令。
- `apps/vps-sync/src/backup/retention.ts` 导出纯函数 `selectBackupDeletions(entries)`。它严格校验 UTC backup key grammar 及 dump/manifest 成对关系，保留最近 30 个有完整 restore point 的 UTC 日期各自最后一点，并保留更早每个日历月最后一点；`null`、不确定、非法或不成对输入均返回 `[]`。实现只返回候选 key，不持有或调用 delete port。
- `apps/vps-sync/src/backup/restore.ts` 导出注入式 `restoreVerify(deps, key, targetUrl)`。流程校验 dump key、canonical manifest、大小/SHA-256，先确认目标库为空且规范化 database identity（host/hostaddr、默认端口、dbname）不等于 production，再以私有 service file 和 PG17 核验 flags (`--dbname=<service> --no-owner --no-privileges --single-transaction`) 调用 `pg_restore`。恢复后校验 migrations/checksums、核心表行数、`publications.verified`，并读取其指向的 immutable snapshot，验证 key/hash/canonical bytes。baseline 只提供 weekday labels 及历史数组的 identity/order；collection、calendar、summary、item 等数据库字段全部来自恢复数据库投影。baseline 缺失、身份集合缺失/额外/不匹配或重新生成 hash 不一致都会 fail closed。恢复流程不 publish、不 notify user data，也没有 CLI/env 输入契约。
- `docs/runbook/vps-data-plane.md` 仅记录上述已实现的注入式接口、安全门和未启用边界。

## TDD 证据

按 brief 先写测试后实现。brief 指定的 pnpm 命令先因本机沙箱禁止 tsx IPC socket 而在测试断言前失败：

```sh
pnpm -F @airing-cal/vps-sync test -- cli.test.ts retention.test.ts restore.test.ts
# FAIL before assertions: Error: listen EPERM .../tsx-*/<pid>.pipe
```

随后使用原生 Node runner 观察 RED（实现文件尚未提供时测试中的 guarded import 明确失败）：

```sh
node --import tsx/esm --test src/cli.test.ts src/backup/retention.test.ts
# RED: 5 tests failed with the explicit not-implemented assertions

node --import tsx/esm --test src/backup/restore.test.ts
# RED: 5 tests failed with the explicit “restore verification flow is not implemented” assertion
```

最小实现后，同一测试集合 GREEN；新增 malformed manifest timestamp 回归后 restore 测试为 10 项：

```sh
node --import tsx/esm --test src/backup/retention.test.ts
# 8 pass, 0 fail

node --import tsx/esm --test src/cli.test.ts
# 2 pass, 0 fail

node --import tsx/esm --test src/backup/restore.test.ts
# 10 pass, 0 fail
```

## 最终验证

- `node --import tsx/esm --test src/cli.test.ts src/backup/retention.test.ts src/backup/restore.test.ts` — PASS，20 pass、0 fail、0 skip（CLI 2 + retention 8 + restore 10）。
- `node --import tsx/esm --test src/backup/backup.test.ts src/backup/restore.test.ts src/backup/retention.test.ts src/cli.test.ts src/media/refresh.test.ts src/postgres/migrate.test.ts src/postgres/repositories.test.ts src/publication/publish.test.ts src/run.test.ts src/upstream/fetch.test.ts src/upstream/retry.test.ts` — PASS，106 pass、0 fail、7 skip；skip 为需要 disposable PostgreSQL 的集成测试。
- `pnpm -F @airing-cal/vps-sync typecheck` — PASS。
- `pnpm -F @airing-cal/vps-sync build:check` — PASS。
- `pnpm -F @airing-cal/vps-sync build` — PASS。
- `git diff --check` — PASS；提交前将再次执行 `git diff --cached --check`。

## PostgreSQL 17 Rule §零 核验与限制

只读检查 `command -v docker podman nerdctl` 未发现可用 container runtime；本机 `pg_restore --version` 是 18.6，因此没有把本机帮助输出当作 PostgreSQL 17 目标证据。按 brief 的 fallback，核对了：

- PostgreSQL 17 [`pg_restore` 官方文档](https://www.postgresql.org/docs/17/app-pgrestore.html)：`--dbname`、`--no-owner`、`--no-privileges`/`--no-acl` 与 `--single-transaction` 参数；
- PostgreSQL `REL_17_STABLE` [`pg_restore.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_restore.c)：对应 flag 解析，且 single-transaction 会启用 exit-on-error；
- 官方 [`postgres:17-alpine` Dockerfile](https://github.com/docker-library/postgres/blob/master/17/alpine3.23/Dockerfile)：从 PostgreSQL 17 源码构建客户端的 recipe。

恢复测试使用 fake command/database/S3 ports，未触碰生产服务；目标镜像内的直接 `pg_restore --help` 和真实 disposable restore 仍需具备 runtime 的后续环境执行。目标 URL 不写入 argv 或日志，连接参数仅写权限为 0600 的临时 libpq service file；恢复临时根和文件为 owner-only 并在 finally 清理。

## 约束与已知限制

- retention 不发送 R2 Delete；实际删除必须另行批准 OpenSpec change。
- Task 5.2 不定义 restore 命令、argv/env 凭据入口或 host-cron/production deployment；Task 9.3 负责 executable restore-drill contract，Task 6.2 负责带 Feishu notifier 的 executable sync wiring。
- restore 的 `RestoreDatabaseSession`、数据库投影和 target URL 均是注入端口；本任务不凭空创建 PostgreSQL/R2/Feishu credentials 或连接适配器。
- 本报告没有修改 plan、OpenSpec task 勾选或 `.comet/subagent-progress.md`。
