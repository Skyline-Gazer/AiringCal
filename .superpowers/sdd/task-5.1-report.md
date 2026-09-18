# Task 5.1 报告：PostgreSQL 备份与校验清单

## 状态

DONE_WITH_CONCERNS — custom-format PostgreSQL dump、SHA-256/size manifest、流式 R2 写入与 backup partial outcome 已实现并通过验证；实现提交 `07b884832477445333d03f56f9470006377530c5` 已推送。唯一验证限制是本机没有容器 runtime，无法直接在目标 `postgres:17-alpine` 镜像执行 CLI `--help`，改按官方 PostgreSQL 17 文档/源码与镜像构建配方核验。

## 实现

- 新增 `apps/vps-sync/src/backup/backup.ts`：`createBackup(deps, run)` 生成 `backups/postgres/YYYY/MM/DD/<timestamp>-<git-sha>.dump` 与同名 `.json`；manifest 使用规范化 JSON，固定字段为 `schema_version`、`run_id`、`git_sha`、`created_at`、`object_key`、`size`、`sha256`。
- `pg_dump` 使用已核验的 `--format=custom` 和 `--file=<private-temp-file>`。先流式读取 dump 计算字节数与 SHA-256，再带已知 `ContentLength` 流式上传 dump，dump 成功后才上传 manifest。
- 数据库 URL 必须非空，`git_sha` 必须为 40 位小写十六进制，否则在启动子进程前 fail closed。URL 不进入 argv 或日志；从 URI 解析连接参数写入权限为 `0600` 的临时 `pg_service.conf`，用 `PGSERVICEFILE` / `PGSERVICE` 选择 service。子进程环境清除继承的 libpq `PG*` 连接变量及 `DATABASE_URL`，避免宿主默认值改变连接目标。错误统一为 `BACKUP_FAILED`。
- 临时工作目录在 `/tmp/airing-cal/backup-*` 下以 owner-only 权限创建，并在 `finally` 清理。
- `apps/vps-sync/src/publication/s3.ts` 增加最小流式 PutObject 端口，同时保留现有 `Uint8Array` 上传。单次 R2 PutObject 上限为 5 GiB；本实现不引入 multipart，接近上限时需先升级 multipart，超限上传错误仍经 backup 边界脱敏并形成 partial。
- `runOnce` 原有逻辑已满足仅在 publication 为 `published` / `no_change` 后运行 backup、backup 失败转为 `partial` 且不撤销 publication，因此 `apps/vps-sync/src/run.ts` 无需改动；`run.test.ts` 补充相应回归测试。
- 同步更新 `docs/runbook/vps-data-plane.md`。没有新增依赖，也未连接生产数据库或 R2；命令执行和对象存储均由测试 fake 覆盖。

## TDD 证据

首次按任务要求启动的 RED 命令：

```sh
pnpm -F @airing-cal/vps-sync test -- backup.test.ts run.test.ts
```

本机 tsx 测试 runner 的 IPC socket 创建遇到 `EPERM`，该次没有得到断言结果。随后从 `apps/vps-sync` 运行原生 Node 测试 runner：

```sh
node --import tsx/esm --test src/backup/backup.test.ts src/run.test.ts
```

实现尚不存在时，测试以 `ERR_MODULE_NOT_FOUND` 找不到 `src/backup/backup.ts` 失败，原有 10 个 run 测试通过，确认了预期 RED。新增连接安全断言后再次以同一原生命令运行，14 项中 12 项通过、2 项失败：失败明确揭示 URL 被错误放入 `PGDATABASE`，且空 URL / 非法 SHA 未能在 spawn 前拒绝。修正后上述安全用例转绿。

## 最终验证

- `pnpm -F @airing-cal/vps-sync test -- backup.test.ts run.test.ts` — PASS：78 项，71 pass、0 fail、7 skip；skip 为需要 disposable PostgreSQL 的集成测试。首次受本机 IPC `EPERM` 影响，之后授权重跑同一命令成功。
- `pnpm -F @airing-cal/vps-sync typecheck` — PASS。
- `pnpm -F @airing-cal/vps-sync build:check` — PASS。
- `git diff --check` — PASS；提交前 `git diff --cached --check` — PASS。
- 实现提交 `07b884832477445333d03f56f9470006377530c5`（`feat(vps-sync): upload verified PostgreSQL backups`）已推送至 `feature/20260914/migrate-data-plane-to-vps`。

## PostgreSQL / R2 合约核验与关注点

本机没有容器 runtime，因此未能在目标 Alpine 镜像实际运行 `pg_dump --help` / `pg_restore --help`。按任务允许的 source fallback，核对了 PostgreSQL 17 的 [pg_dump 文档](https://www.postgresql.org/docs/17/app-pgdump.html)、[pg_restore 文档](https://www.postgresql.org/docs/17/app-pgrestore.html)、[libpq 环境变量](https://www.postgresql.org/docs/17/libpq-envars.html)、[连接服务文件](https://www.postgresql.org/docs/17/libpq-pgservice.html)、[连接参数说明](https://www.postgresql.org/docs/17/libpq-connect.html)，以及 [`postgres:17-alpine` 构建配方](https://github.com/docker-library/postgres/blob/master/17/alpine3.23/Dockerfile)（从 PostgreSQL 17 源码构建客户端）。这些来源确认 custom archive、输出文件和 libpq service/env 的用法；本地未直接执行目标镜像 help 仍是本报告的验证 caveat。

流式上传使用已安装 AWS SDK 类型声明支持的 Node `Readable` `Body` 与 `ContentLength`；R2 [上传文档](https://developers.cloudflare.com/r2/objects/upload-objects/)和[错误码文档](https://developers.cloudflare.com/r2/api/error-codes/)标明单次 PutObject 的 5 GiB 上限。本任务有意不实现 multipart；大备份需先完成 multipart 升级再提高该限制。测试只使用 fake runner / fake S3 client，未触碰生产服务。

本次报告补充不修改计划、OpenSpec、实现代码或 `.comet/subagent-progress.md`。

## 本轮评审修复

- URI 解析支持 query 中的 `dbname`；query 值按 libpq 后写覆盖 path 的 `dbname`。path、query、user、password 均执行 percent decoding，query 中未编码的 `+` 保持字面加号。规则依据 PostgreSQL 17 [connection URI 文档](https://www.postgresql.org/docs/17/libpq-connect.html)和 [`fe-connect.c`](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c) 核验。
- 写临时文件前通过 `lstat` 验证 `/tmp/airing-cal`：不存在时以 `0700` 创建后再验证；已存在目录须非符号链接、由当前 UID 所有、owner 可访问且无 group/world 权限。验证失败时立即拒绝，不修改既有权限。新增覆盖 0700 新根、宽权限根与符号链接根。
- Runbook 改为说明 dump“可由 `pg_restore` 恢复”，并描述临时根检查；目标镜像没有容器 runtime、未直接运行 `--help` 的一次性验证限制保留在本报告，不再出现在 runbook。本轮没有接入运行时 caller 或创建 CLI。

TDD 证据（均在 `apps/vps-sync` 目录执行）：

```sh
node --import tsx/esm --test src/backup/backup.test.ts
```

RED：9 项中 4 pass、5 fail。5 个预期失败分别复现 query `dbname` 被拒绝、path `%2F` 未解码、query `+` 被当作空格、宽权限 root 被接受、symlink root 被接受。

GREEN：同一命令 9/9 pass。之后的 focused 回归命令：

```sh
node --import tsx/esm --test src/backup/backup.test.ts src/run.test.ts
```

19/19 pass。`pnpm -F @airing-cal/vps-sync typecheck`、`pnpm -F @airing-cal/vps-sync build:check` 与 `git diff --check` 均通过。目标 `postgres:17-alpine` CLI help 未在容器内直接运行的验证限制仍如上文所述。

## 文档边界

本轮 runbook 更新描述 Task 5.1 已实现的 `createBackup` adapter 与 `runOnce` backup-port contract，不表示生产 CLI 或定时备份已启用；production composition wiring 属于 Task 5.2。此轮只改文档，未改 runtime、plan/OpenSpec 或 `.comet/subagent-progress.md`。
