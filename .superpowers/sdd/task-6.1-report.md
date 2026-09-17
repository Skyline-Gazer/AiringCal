# Task 6.1 报告：飞书 payload 与签名

## 状态

PASS — 已实现纯 Feishu 自定义机器人消息构造、官方签名算法和错误/凭据脱敏。实现只接收结构化 `RunResult`，不发起 webhook 请求、不持久化通知结果、不实现 retry 或 executable sync；这些属于 Task 6.2。

## 官方契约核验

官方来源：[飞书开放平台《自定义机器人使用指南》](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。访问日期：2026-09-17；页面标注最后更新：2025-03-27。

已核验并据此实现：

- 请求使用 HTTP POST JSON；基础消息体包含 `msg_type` 与 `content`，签名开启时加入字符串秒级 `timestamp` 与 `sign`。
- `timestamp` 的单位为秒，必须距当前时间不超过 3600 秒（1 小时）。
- `sign` 使用 `timestamp + "\\n" + secret` 作为 HMAC-SHA256 key，对空字符串计算，再进行 Base64 编码；`signFeishu` 使用 Node 标准库 `node:crypto` 实现。
- 成功响应的 `code` 为 `0`；官方标注 `StatusCode`/`StatusMessage` 为兼容旧逻辑的冗余字段，不作为判断依据。
- 官方页面同时说明请求体上限为 20 KB；Task 6.2 负责投递与成功响应校验。

## 实现与测试

- `feishu.ts` 输出 text-only payload，覆盖 `success`、`no_change`、`partial`、`failed`、`skipped`；映射 run/mode/source/time、generation/hash、counts、stage durations、publication/backup/notification、git/node/alpine 字段。`runOnce` 将依赖注入的 Git SHA 复制到 `RunResult.gitSha`；消息边界只接受严格 40 位小写 hex，否则输出 `unknown`。Alpine 仍明确为 `unknown`，Node 使用 `process.version`。
- `redact.ts` 替换 URL、Bearer/Basic 与授权 header、token/key/secret/password/credential 形式、数据库/R2 credential 和 raw exception 文本。消息只读取 allow-listed 结构化字段，不复制未知对象属性。
- 时间格式使用 `Intl.DateTimeFormat` 的 `Asia/Shanghai`，不安装或依赖 tzdata。

按 TDD 先写测试并观察 RED：

```sh
pnpm -F @airing-cal/vps-sync test -- feishu.test.ts
# FAIL before assertions: tsx IPC pipe 被 sandbox 拒绝（listen EPERM）

node --import tsx/esm --test src/notification/feishu.test.ts
# RED: implementation module 不存在（ERR_MODULE_NOT_FOUND）
```

最小实现后 GREEN：

```sh
node --import tsx/esm --test src/notification/feishu.test.ts
# PASS，5 pass、0 fail、0 skip

node --import tsx/esm --test src/**/*.test.ts
# PASS，134 tests：127 pass、0 fail、7 skip；skip 均为需要 disposable PostgreSQL 的集成测试
```

随后为“所有终态始终有 duration 字段”补充回归：旧实现为 4 pass / 1 fail（缺少 `duration=10200ms`），加入最小总耗时映射后 focused suite 回到 5/5 GREEN。

## 第 1 轮复审修复

复审发现原有正则脱敏不是 fail-closed：`DATABASE_URL=...`、`Authorization=...`、`WEBHOOK_URL=...`、`R2_ENDPOINT=...` 与 `raw exception: ...` 仍可能留下自由字符串；`SanitizedError` 和 `PreviousNotificationFailure` 也仍是普通 `string`。本轮在消息边界为 `category`、`code`、`stage` 增加严格 canonical allow-list，任何未知值整体输出 `unknown`，并补齐上述键值形态的 `redactText` 回归。另修复合法 `components: {}` 经过 `safeText(undefined)` 产生 `"undefined"` 的问题，统一输出 `not_attempted`。

TDD 修复循环：

```sh
node --import tsx/esm --test src/notification/feishu.test.ts
# RED：7 tests，5 pass、2 fail；分别暴露自由错误字段泄漏与 omitted component 输出 undefined

node --import tsx/esm --test src/notification/feishu.test.ts
# GREEN：7 pass、0 fail、0 skip
```

新增回归覆盖五个具体敏感输入、canonical unknown 输出、直接 `redactText` 结果以及空 `RunComponents` fallback。

## 第 2 轮复审修复：Git provenance

复审发现 `RunDependencies.gitSha` 虽已传给 coordinator/backup/publication，但 `RunResult` 没有携带它，Feishu message 因而始终输出 `git_sha=unknown`。本轮仅把 SHA 加入 sanitized `RunResult` 调用链；`authority.finishRun` 仍接收既有 `RunFinishInput` 字段并忽略该额外通知元数据，数据库持久化形状不变。

按 TDD 先写回归并观察 RED：

```sh
node --import tsx/esm --test src/notification/feishu.test.ts src/run.test.ts
# RED：19 tests，16 pass、3 fail；Feishu 实际仍为 git_sha=unknown，runOnce 与 notifier 输入的 gitSha 为 undefined
```

最小 GREEN 为 `RunResult.gitSha`、`runOnce` 初始化和严格 Feishu SHA 校验；新增回归覆盖实际 40 位小写 SHA 以及大写/长度错误/自由字符串的 fail-closed fallback：

```sh
node --import tsx/esm --test src/notification/feishu.test.ts src/run.test.ts
# GREEN：19 pass、0 fail、0 skip
```

## 最终验证

- `pnpm -F @airing-cal/vps-sync typecheck` — PASS。
- `pnpm -F @airing-cal/vps-sync build:check` — PASS。
- `git diff --check` — PASS。
- 直接 `node --import tsx/esm` runner 用于绕过本机 sandbox 对 `tsx` IPC socket 的限制；未把包脚本的 `EPERM` 误报为测试断言失败。

复审修复后的完整 vps-sync runner：`node --import tsx/esm --test src/**/*.test.ts` — 138 tests：131 pass、0 fail、7 skip；skip 均为需要 disposable PostgreSQL 的集成测试。包级 `pnpm -F @airing-cal/vps-sync test -- feishu.test.ts run.test.ts` 仍受本机 `tsx` IPC `listen EPERM` 限制，原生 runner 已通过同一套测试文件。

## 限制与范围

- 未发送真实 Feishu 请求，未使用真实 webhook URL/secret；Task 6.2 负责 bounded delivery、成功响应解析、`notification_failed` persistence、previous-failure 注入和 executable sync composition。
- 本任务未修改 controller checkpoint、plan 或 OpenSpec tasks，也未实现 webhook 投递、持久化、cron 或生产切换。
