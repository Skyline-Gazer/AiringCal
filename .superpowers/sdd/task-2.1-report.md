# Task 2.1 实施报告：完整上游抓取与有界 retry

## 结果

已实现 `@airing-cal/vps-sync` 的完整上游输入抓取边界：

- `withRetry` 将错误归类为 `auth`、`not_found`、`rate_limited`、`upstream`、`timeout`、`network`、`contract`，认证与 404 终态一次失败，429/5xx/超时/网络错误最多三次外层尝试。
- 合法 `Retry-After` 支持秒数和 HTTP-date，并受 `maxDelayMs` 上限约束；无效值使用有界指数退避与可注入 jitter。
- `UpstreamFetchError` 只暴露稳定的 `category`、`code`、`stage`、`attempt`，不会携带 token、URL、响应 body 或底层异常消息。
- `fetchCompleteInput` 按配置抓取所有用户的全部 collection 分页，再抓取 calendar；分页总数/offset/limit/长度/重复 subject、响应 schema、calendar 结构均校验。primary user、任一分页或 calendar 不完整时 fail closed，不生成 `CompleteFullFetch`。
- `createUpstreamBgmClient` 使用 `maxGetRetries: 0`；对实际 `BgmClient` 拒绝隐式 retry 配置，确保 retry 只发生在外层。
- 更新 VPS data-plane runbook 的上游错误处理表。

## 修改文件

- `apps/vps-sync/src/upstream/retry.ts`
- `apps/vps-sync/src/upstream/retry.test.ts`
- `apps/vps-sync/src/upstream/fetch.ts`
- `apps/vps-sync/src/upstream/fetch.test.ts`
- `apps/vps-sync/package.json`
- `apps/vps-sync/tsconfig.json`（使 workspace 中真实 BgmClient 的相对 `.ts` imports 能在当前 TypeScript 配置下参与 typecheck）
- `pnpm-lock.yaml`
- `docs/runbook/vps-data-plane.md`

## Verify Before Writing 记录

实现前核对了 `docs/example/api/bgm-api.json`：

- `GET /v0/users/{username}/collections` 使用可选 Bearer，`limit` 为 1–50、默认 30，`offset` 最小为 0，响应为带 `total/limit/offset/data` 的分页 collection schema。
- `GET /calendar` 无 Bearer 要求，响应为 weekday 与 items 数组。
- `GET /v0/subjects/{subject_id}` 使用可选 Bearer，响应为 Subject detail schema。

同时读取了 `packages/bgm-api/src/bgm-client.ts` 的真实 constructor、options 和方法：`new BgmClient(token?, { maxGetRetries, ... })`、`getCollections`、`getCalendar`、`getSubject`。没有新增未经本地 source/type 验证的 package、配置 key 或 API 调用。

## TDD 证据

RED：

```text
pnpm -F @airing-cal/vps-sync test -- retry.test.ts fetch.test.ts
```

在允许测试进程监听管道后，新增测试因 `src/upstream/retry.ts` 与 `src/upstream/fetch.ts` 尚不存在而失败（`ERR_MODULE_NOT_FOUND`）；这是预期的 RED。沙箱内第一次运行另有 `listen EPERM` 环境限制，未作为行为 RED 依据。

GREEN：

```text
pnpm -F @airing-cal/vps-sync test -- retry.test.ts fetch.test.ts
```

通过：24 tests，17 passed，0 failed，7 个已有 PostgreSQL integration tests skipped。新增测试证明 429 实际只产生 3 次 fetch 请求、401/403 各 1 次请求，且 invalid JSON 为一次性的 contract failure。

## 验证命令

以下命令均通过：

```text
pnpm -F @airing-cal/vps-sync typecheck
pnpm -F @airing-cal/vps-sync test
pnpm -F @airing-cal/vps-sync build
pnpm install --offline --frozen-lockfile
pnpm test
pnpm typecheck
git diff --check
```

## 已知顾虑

当前分支没有从 domain package 导出 brief 中提到的 `assembleFullFetch`；该边界的等价完整性校验暂时位于 `apps/vps-sync/src/upstream/fetch.ts`，因此后续若共享 domain export 落地，应把这里改为直接复用共享实现。当前 `BgmClient` 也没有把响应的 `Retry-After` 保存到抛出的 `BgmHttpError`；适配器已支持读取 error/header 上的 metadata 并进行上限裁剪，但真实 client 在缺少 metadata 时会回退到 jitter。两点均未扩大到 brief 禁止修改的 package 文件。

## 提交

提交信息：`feat(vps-sync): fetch complete upstream state`

## 审查修复报告（2026-09-14）

### 修复范围

- 将 `assembleFullFetch`、`CollectionFetchPage`、`CollectionFetchGroup` 与 `CompleteFullFetch` 移入 `@airing-cal/bgm-api`；`apps/sync-worker/src/full-fetch-boundary.ts` 仅保留兼容 wrapper，VPS 上游抓取直接复用 package 导出，删除第二份组装逻辑。
- `BgmHttpError` 增加可选的 `retryAfter` 安全元数据，仅从 429/5xx 响应的 `Retry-After` header 复制值；构造器原有调用兼容。VPS retry 继续读取该字段并执行已有上限/回退策略。
- VPS collection boundary 将 OpenAPI transport SlimSubject 显式归一化为 `BgmSlimSubject`：`short_summary`→`summary`、`score/rank/collection_total`→`rating`，保留名称、日期、图片与 eps，使用已验证 `total_episodes` 或 eps fallback，并保留真实布尔 `nsfw` 或安全默认；同时接受现有 typed canonical subject fixtures。
- 未修改 plan、OpenSpec 或 `.comet.yaml`，未调用真实 API，未勾选任务。

### TDD 证据

RED：

```text
pnpm -F @airing-cal/vps-sync test -- retry.test.ts fetch.test.ts
```

在允许 `tsx` IPC 管道后，26 tests 中 2 个新增 SlimSubject 断言失败（17 passed、7 skipped），分别显示 transport 字段未归一化与 typed subject 被 contract 拒绝。

```text
pnpm -F @airing-cal/bgm-api test -- src/bgm-client.test.ts
```

23 tests 中新增真实 client 断言失败（22 passed、1 failed）：`maxGetRetries: 0` 的 429/503 `BgmHttpError` 没有 `retryAfter`。

```text
pnpm -F @airing-cal/sync-worker test -- src/full-fetch-boundary.test.ts
```

新增 wrapper identity 断言在 package 尚无导出时失败：`@airing-cal/bgm-api` 不提供 `assembleFullFetch`。

GREEN：

```text
pnpm -F @airing-cal/vps-sync test -- retry.test.ts fetch.test.ts
```

26 tests：19 passed、0 failed、7 skipped（既有 PostgreSQL integration 条件跳过）。

```text
pnpm -F @airing-cal/bgm-api test
pnpm -F @airing-cal/sync-worker test
```

分别为 29/29 与 228/228 passed。

### 验证命令

```text
pnpm test                         # exit 0，workspace 全量测试通过
pnpm typecheck                    # exit 0，workspace typecheck 通过
pnpm -F @airing-cal/vps-sync build # exit 0
pnpm build:check                  # exit 0；Wrangler 仅输出既有本机日志目录 EPERM 噪声，dry-run/type checks 完成
git diff --check                  # exit 0
```

### 顾虑

- 本环境未配置 disposable PostgreSQL，因此 vps-sync 既有 7 个数据库集成用例保持 skipped；单元与 workspace 回归均通过。
- `pnpm build:check` 的 Wrangler 子进程尝试写用户目录日志时打印 `EPERM`，但各 dry-run 与命令整体 exit 0；这不是本次代码变更引入的失败。

修复提交 subject：`fix(vps-sync): share and normalize upstream boundary`
