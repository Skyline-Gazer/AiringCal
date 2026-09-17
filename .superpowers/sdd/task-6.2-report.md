# Task 6.2 报告：飞书投递与 `notification_failed` persistence

## 状态

PASS（实现与本机可执行验证完成；未发送真实 Feishu 请求、未执行生产切换）。`runOnce` 先持久化业务终态，再进行通知；通知失败只写独立的 `notification_failed` 摘要，不改变业务 `status`、publication 或 backup。

## 独立复审修复：run boundary 与 notification heartbeat

复审发现锁、`beginRun`、首次 notification heartbeat 和 cleanup 的异常可能越过终态路径。先加入四个回归场景并运行 RED：

```sh
node --import tsx/esm --test src/run.test.ts
# 17 tests：13 pass、4 fail；失败分别复现 lock/begin 原始异常泄漏、clock 初始化直接 reject、cleanup 覆盖业务结果、notification heartbeat 跳过 notifier
```

GREEN 将边界异常统一映射为稳定的 `runtime/STAGE_FAILED` 摘要；`finishRun`、previous-failure 读取、lock release 和 pool close 均 best-effort 且吞掉底层异常。没有成功 `beginRun` 时仍尝试一次终态通知；notification heartbeat 失败只标记 `notification_failed`，仍调用真实 notifier 一次，并保留业务 `status`、publication 与 backup。notifier 没有 retry/循环，旧的 `Promise<void>` callers 仍按非 `failed` 结果视为已投递。

复审修复 GREEN：

```sh
node --import tsx/esm --test src/run.test.ts
# 17/17 pass
```

新增测试不把底层 `postgres://...` 异常放入结果、通知或 cleanup 路径；cleanup 失败只产生稳定摘要，不改变业务终态字段。

## 官方契约与配置核验

官方来源：[飞书开放平台《自定义机器人使用指南》](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。访问日期：2026-09-17；页面标注最后更新：2025-03-27。Task 6.1 report 已记录同一来源，本任务复核后沿用其结论：

- 请求为 HTTP POST JSON，基础 body 使用 `msg_type` 和 `content`；签名开启时加入字符串秒级 `timestamp` 与 `sign`。
- 签名使用 `timestamp + "\\n" + secret` 作为 HMAC-SHA256 key，对空字符串计算后 Base64 编码；`timestamp` 必须距当前不超过 3600 秒。
- 成功只接受响应 JSON 的 `code === 0`；`StatusCode`/`StatusMessage` 不作为成功判定。
- 请求体上限为 20 KiB。

修改 CLI/配置前核对了现有 package scripts、TypeScript/fetch/AbortController 类型和 vps-sync 源码；仓库此前没有 Feishu env contract。`cli.ts` 因此只增加明确的应用层入口配置：必填 `FEISHU_WEBHOOK_URL`，可选 `FEISHU_WEBHOOK_TOKEN`、`FEISHU_WEBHOOK_SECRET`、`FEISHU_TIMEOUT_MS`。secret/token/URL 只在进程内使用，不进入 argv、日志、消息或数据库。

## TDD：RED → GREEN

先添加 `deliver.test.ts`、run/repository/CLI 回归测试，并运行：

```sh
node --import tsx/esm --test src/notification/deliver.test.ts src/run.test.ts src/postgres/repositories.test.ts src/cli.test.ts
```

RED 阶段观察到 23 tests 中 6 failures：delivery 模块明确未实现；通知失败仍被当作成功；previous compact failure 未传递。PostgreSQL integration 在未设置 disposable database 时按既有约定 skip。

GREEN 阶段实现并覆盖：

- 注入式 `fetch`/clock、单次 POST、20 KiB body limit、有界 timeout、AbortController cleanup；timeout 同时覆盖 response body 解析，不做额外 retry。
- non-2xx、invalid JSON、非零/缺失 `code`、网络异常和 timeout 均返回 `failed`，不抛出到业务边界；稳定 logger entry 不包含 transport credential、签名、URL、DB URL 或 raw exception。
- query token 与可选 Feishu signature 的真实 request body 组合。
- 业务 terminal `finishRun` 先发生；通知失败随后仅更新 `notification_failed`，业务终态和 publication/backup 保持不变。
- `getPreviousNotificationFailure(excludeRunId)` 排除当前刚完成 run，下一次通知读取上一条完成 run 的 compact `{category,code,stage,attemptCount}`；数据库不会保存异常正文。
- `createFeishuNotifier`、`createSyncEntrypoint` 和命名 `sync` 入口始终安装真实 `deliverNotification`，没有 no-op notifier；`cli.ts` 也提供带 shebang 的 process-facing `main`，无运行时 composition 时 fail closed。

## 验证命令与结果

包脚本 focused 命令按要求尝试过，但本机 sandbox 对 `tsx` IPC pipe 的 `listen` 被拒绝：

```text
pnpm -F @airing-cal/vps-sync test -- deliver.test.ts run.test.ts repositories.test.ts cli.test.ts
# FAIL before tests: listen EPERM .../tsx-*/<pid>.pipe
```

使用仓库原生 Node runner 完成同一套测试：

```sh
node --import tsx/esm --test src/notification/deliver.test.ts src/run.test.ts src/postgres/repositories.test.ts src/cli.test.ts
# 31 tests：30 pass、0 fail、1 skip（disposable PostgreSQL 未配置）

node --import tsx/esm --test src/**/*.test.ts
# 150 tests：143 pass、0 fail、7 skip（既有 PostgreSQL integration gates）

pnpm -F @airing-cal/vps-sync typecheck
# PASS

pnpm -F @airing-cal/vps-sync build:check
# PASS

pnpm -F @airing-cal/vps-sync build
# PASS

pnpm exec openspec validate migrate-data-plane-to-vps --strict --no-interactive
# Change 'migrate-data-plane-to-vps' is valid

git diff --check
# PASS
```

还执行了 `pnpm -F @airing-cal/vps-sync build:check`、`pnpm -F @airing-cal/vps-sync build`、`git diff --check` 与相关 strict OpenSpec 检查；结果写入交付摘要。具备 disposable PostgreSQL 的 CI/开发机仍需启用 `VPS_SYNC_TEST_DATABASE=1` 运行 migration/repository integration。

## 数据库与安全范围

新增 `0003_notification_failed.sql`，只给 `sync_runs` 增加可空 JSONB `notification_failed` 列，并限制为 object；仓储层再校验固定 category/code/stage/attemptCount。没有新增 secret、raw exception、URL、header、signature 或 DATABASE_URL 持久化字段。没有修改 controller checkpoint、plan、OpenSpec tasks，也没有执行真实 webhook、cron、容器发布或生产切换。

## 已知限制

- 本任务提供可注入的 executable `sync` composition 和 process-facing wrapper；完整 PostgreSQL/upstream/R2 生产 adapter 仍由部署层组合，Task 7/9 负责容器与切换流程。没有 runtime composition 时，直接 `cli.js sync` 会输出稳定错误并以非零退出，不会静默 no-op。
- 由于现有 workspace packages 的 `exports` 仍指向 TypeScript source，裸 `node dist/cli.js` 在当前 monorepo checkout 会被 Node 的 strip-only TypeScript loader 拒绝；使用仓库既有 `tsx` runner 可执行入口，Task 7.1 的 production image 需沿用其依赖构建策略。
- 本机没有 disposable PostgreSQL，因此 migration/repository integration 只按既有测试约定 skip；没有用单元测试替代该门槛。
- 没有对真实 Feishu endpoint 发请求，也没有增加自动重试；一次失败由下一次同步读取 compact failure summary。
