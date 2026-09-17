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

- `feishu.ts` 输出 text-only payload，覆盖 `success`、`no_change`、`partial`、`failed`、`skipped`；映射 run/mode/source/time、generation/hash、counts、stage durations、publication/backup/notification、git/node/alpine 字段。当前 `RunResult` 没有 build metadata，因此 git/alpine 明确输出 `unknown`，Node 使用 `process.version`。
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

## 最终验证

- `pnpm -F @airing-cal/vps-sync typecheck` — PASS。
- `pnpm -F @airing-cal/vps-sync build:check` — PASS。
- `git diff --check` — PASS。
- 直接 `node --import tsx/esm` runner 用于绕过本机 sandbox 对 `tsx` IPC socket 的限制；未把包脚本的 `EPERM` 误报为测试断言失败。

## 限制与范围

- 未发送真实 Feishu 请求，未使用真实 webhook URL/secret；Task 6.2 负责 bounded delivery、成功响应解析、`notification_failed` persistence、previous-failure 注入和 executable sync composition。
- 本任务未修改 controller checkpoint、plan 或 OpenSpec tasks，也未实现 webhook 投递、持久化、cron 或生产切换。
