# Task 5.2 报告：备份保留与安全恢复校验

## 状态

DONE_WITH_CONCERNS — `runOnce` 的注入式 backup composition、纯保留候选选择和安全 restore verification 已实现并通过单元/类型/构建验证。当前工作机没有容器 runtime，无法直接在 `postgres:17-alpine` 目标镜像内执行 `pg_restore --help` 或真实恢复演练；已按任务要求用 PostgreSQL 17 官方文档、源码和镜像构建配方完成只读核验（见下文）。本任务没有启用 executable `sync`/restore 命令、生产调度、生产数据库/R2 操作或 R2 删除。

## 实现

- `apps/vps-sync/src/cli.ts` 导出 `runOnceWithBackup` 注入式 composition。调用方必须提供真实 `notify` port 和 `backupConfig`；composition 使用已实现的 `createBackup`，沿用 `runOnce` 仅在 `published` / `no_change` 后执行 backup、backup 失败转 `partial` 且保留 publication 的语义。没有注册 executable `sync` 命令。
- `apps/vps-sync/src/backup/retention.ts` 导出纯函数 `selectBackupDeletions(entries)`。它严格校验 UTC backup key grammar 及 dump/manifest 成对关系，保留最近 30 个有完整 restore point 的 UTC 日期各自最后一点，并保留更早每个日历月最后一点；`null`、不确定、非法或不成对输入均返回 `[]`。实现只返回候选 key，不持有或调用 delete port。
- `apps/vps-sync/src/backup/restore.ts` 导出注入式 `restoreVerify(deps, key, targetUrl)`。流程校验 dump key、canonical manifest、大小/SHA-256，再由同一 target session 的 `withSessionLock` 覆盖空库检查与恢复；规范化 database identity（host/hostaddr、默认端口、dbname）不等于 production，随后以私有 service file 和 PG17 核验 flags (`--dbname=service=<service> --no-owner --no-privileges --single-transaction`) 调用 `pg_restore`。恢复后校验 migrations/checksums、核心表行数、`publications.verified`，并读取其指向的 immutable snapshot，验证 key/hash/canonical bytes。baseline 只提供 weekday labels 及历史数组的 identity/order；collection、calendar、summary、item 等数据库字段全部来自恢复数据库投影。baseline 缺失、身份集合缺失/额外/不匹配或重新生成 hash 不一致都会 fail closed。恢复流程不 publish、不 notify user data，也没有 CLI/env 输入契约。
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

- `node --import tsx/esm --test src/cli.test.ts src/backup/retention.test.ts src/backup/restore.test.ts` — PASS，25 pass、0 fail、0 skip（CLI 2 + retention 9 + restore 14）。
- `node --import tsx/esm --test src/backup/backup.test.ts src/backup/restore.test.ts src/backup/retention.test.ts src/cli.test.ts src/media/refresh.test.ts src/postgres/migrate.test.ts src/postgres/repositories.test.ts src/publication/publish.test.ts src/run.test.ts src/upstream/fetch.test.ts src/upstream/retry.test.ts` — PASS，111 pass、0 fail、7 skip（共 118 tests）；skip 为需要 disposable PostgreSQL 的集成测试。
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
- 本修复 agent 没有修改 plan、OpenSpec task 勾选或 `.comet/subagent-progress.md`；controller scope 的编排提交可能包含这些 controller artifacts，它们不属于本 implementer 允许文件，也不在本报告中宣称为 Task 5.2 实现内容。

## Reviewer 修复轮次（2026-09-16）

按要求每个修复均先写回归测试并观察 RED，再写最小修复并观察 GREEN：

- `0962c2c fix(vps-sync): bind restore to service connection`：先把 restore test 的 `--dbname` 期望改为 `--dbname=service=airing-cal-restore`，旧实现 RED；随后使用 service connection string，restore suite 10/10 GREEN。
- `0425620 fix(vps-sync): fail closed on retention timestamp ties`：新增同一 UTC timestamp、不同 git SHA 的 retention case，旧实现按 key 字典序选择并 RED；`latest` 遇 timestamp 平局返回不确定，selector 返回 `[]`，retention 9/9 GREEN。
- `24d7bec fix(vps-sync): bind backup manifest provenance`：先校正合法 fixture 的 key SHA，并新增 manifest `git_sha`/`created_at` 与 key 不匹配的 fail-closed cases，旧实现缺少 rejection 而 RED；key parser 导出 canonical timestamp/SHA，manifest 逐字段绑定，restore suite 12/12 GREEN。
- `c73dfa9 fix(vps-sync): hold target lock through restore`：新增 target session 无法取得 empty lock 时不得调用 `pg_restore` 的 case，旧实现仍继续 restore 而 RED；`withSessionLock` 回调覆盖空库检查、restore 与校验，锁不可用时回调不执行，restore suite 13/13 GREEN。该 port 的边界已在 runbook 说明：只约束遵守同一 advisory-session-lock 协议的写者，外部不合作连接/超级用户不在保证内。
- `c840bf3 fix(vps-sync): require migration checksums`：新增仅传 migration names 的 case，旧兼容分支将 checksum 置空并错误通过而 RED；`expectedMigrations` 仅接受 `{ name, checksum }` 且始终精确比较，restore suite 14/14 GREEN。

修复后 focused fallback：

```sh
node --import tsx/esm --test src/cli.test.ts src/backup/retention.test.ts src/backup/restore.test.ts
# PASS，25 pass、0 fail、0 skip
```

brief 指定的 pnpm 命令仍因本机沙箱禁止 tsx IPC socket 失败（`listen EPERM .../tsx-*/<pid>.pipe`）；这是 runner 环境限制，不是断言失败。完整 vps-sync fallback：

```sh
node --import tsx/esm --test src/backup/backup.test.ts src/backup/restore.test.ts src/backup/retention.test.ts src/cli.test.ts src/media/refresh.test.ts src/postgres/migrate.test.ts src/postgres/repositories.test.ts src/publication/publish.test.ts src/run.test.ts src/upstream/fetch.test.ts src/upstream/retry.test.ts
# PASS，118 tests：111 pass、0 fail、7 skip；skip 均为需 disposable PostgreSQL 的集成测试
pnpm -F @airing-cal/vps-sync typecheck
pnpm -F @airing-cal/vps-sync build:check
pnpm -F @airing-cal/vps-sync build
git diff --check
# 全部 PASS
```

PostgreSQL 17 连接形式证据：本机 `pg_restore --version` 为 18.6，`pg_restore --help` 显示 `--dbname=NAME`、`--single-transaction`、`--no-owner` 与 `--no-privileges`；本机没有 docker/podman/nerdctl，因此未把本机帮助冒充 PG17 target-image 证据。PG17 官方 [pg_restore 文档](https://www.postgresql.org/docs/17/app-pgrestore.html)明确 `--dbname` 可接收 connection string 且其参数覆盖冲突选项；PG17 [libpq connection 文档](https://www.postgresql.org/docs/17/libpq-connect.html)定义 `keyword=value` connection string；PG17 `REL_17_STABLE` [`pg_restore.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_restore.c)显示 `-d/--dbname` 将参数传入 connection params；官方 [`postgres:17-alpine` Dockerfile](https://github.com/docker-library/postgres/blob/master/17/alpine3.23/Dockerfile)是目标客户端构建 recipe。因此实现使用 `--dbname=service=airing-cal-restore` 配合 0600 `PGSERVICEFILE`，目标 URL/secret 不进 argv 或日志。

## 最终允许修复轮（2026-09-16，round 2/2）

- 根因回归 RED：在旧实现上新增 hostaddr 选择生产 endpoint、多主机 URI/`host`/`hostaddr` 列表，以及 expected/actual 空 migration 列表、空 checksum、畸形 checksum 和字符串条目测试；原生 runner 为 20 项测试 15 pass、5 fail（hostaddr 生产身份与三类 migration 绕过），失败均发生在断言层而非测试装载错误。
- 最小 GREEN：`databaseIdentity` 按 PG17 libpq 有效 endpoint 归一化（`hostaddr` 存在时取 `hostaddr`，并绑定端口/数据库名），`connectionParts` 拒绝 `host`/`hostaddr`/`port` 逗号列表及非 IP `hostaddr`；migration 校验要求 expected 与 actual 均为非空严格对象列表和 64 位小写 SHA-256。新增回归和原有 restore suite 共 20/20 pass。
- 提交：`b3db2d1 fix(vps-sync): harden restore endpoint and migrations`，已推送到 `feature/20260914/migrate-data-plane-to-vps`。
- amended focused fallback：`node --import tsx/esm --test src/cli.test.ts src/backup/retention.test.ts src/backup/restore.test.ts` — 31 pass、0 fail、0 skip。brief 指定的 `pnpm -F @airing-cal/vps-sync test -- cli.test.ts retention.test.ts restore.test.ts` 仍在测试断言前因沙箱禁止 tsx IPC socket 失败（`listen EPERM .../tsx-*/<pid>.pipe`）。
- full vps-sync fallback：上述完整 Node runner — 124 tests，117 pass、0 fail、7 skip；skip 均为需 disposable PostgreSQL 的集成测试。
- `pnpm -F @airing-cal/vps-sync typecheck`、`build:check`、`build` 与 `git diff --check` — 全部 PASS。
- PG17 语义核验：官方 [libpq connection 文档](https://www.postgresql.org/docs/17/libpq-connect.html)规定 `host`/`hostaddr` 可为逗号分隔列表，且同时指定时 `hostaddr` 提供服务器网络地址；PG17 `REL_17_STABLE` [`fe-connect.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c)按 `hostaddr` 列表建立连接槽并将非空 `hostaddr` 标为实际 host-address 类型。实现据此拒绝多主机歧义并按有效网络 endpoint 比较生产身份。目标 URL 与 secret 仍不进入 argv 或日志。
- 限制不变：本机没有 docker/podman/nerdctl，未能在 `postgres:17-alpine` 目标镜像内直接执行 `pg_restore --help` 或真实恢复演练；已按 PG17 官方文档、源码和官方镜像构建配方使用允许的 fallback。未启用 executable sync/restore、生产调度、生产数据库/R2 操作或 R2 删除，也未修改 plan/OpenSpec/checkpoint。

## 用户授权的额外修复轮（2026-09-16，round 3）

- 根因：`connectionParts` 无条件要求 `host` 非空，导致合法的 PostgreSQL 17 `hostaddr`-only URL 在 production identity 比较时被拒绝，无法继续到恢复流程。
- RED：新增两个回归测试后，`node --import tsx/esm --test apps/vps-sync/src/backup/restore.test.ts` 为 22 项测试 20 pass、2 fail。非生产 `postgresql:///?hostaddr=127.0.0.1&dbname=db` 和指向 production hostaddr 的目标都在 `connectionParts` 抛出 `RESTORE_TARGET_INVALID`；生产 identity 测试因此未能到达预期的 identity gate。
- GREEN：仅当 `host` 与 `hostaddr` 都为空时拒绝；保留逗号多 host、端口列表和无效 IP 拒绝。hostaddr-only 非生产目标调用注入的 `pg_restore` 并通过 restore 验证；hostaddr-only 生产 endpoint 返回 `RESTORE_TARGET_IS_PRODUCTION`，调用 `pg_restore` 次数为 0。相同 focused 命令现为 22 pass、0 fail、0 skip。
- 本轮完整要求验证：`pnpm -F @airing-cal/vps-sync typecheck`、`pnpm -F @airing-cal/vps-sync build:check`、`pnpm -F @airing-cal/vps-sync build` 与 `git diff --check` 均 PASS。
- 测试通过注入的 fake database 与 command runner 验证流程，没有连接 PostgreSQL 17 实例；之前记录的本机缺少容器 runtime 的限制仍适用。本轮未修改计划、OpenSpec checkbox 或 `.comet/subagent-progress.md`。
