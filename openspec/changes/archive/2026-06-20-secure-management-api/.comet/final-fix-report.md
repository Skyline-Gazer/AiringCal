# secure-management-api 最终整分支审查第 1 轮统一修复报告

## 结果

- 状态：DONE
- 提交：`2f95090 fix: close secure management review gaps`
- 提交数量：1
- 未提交本报告；未提交或回滚其他 agent 的 `.comet` 文件。

## 根因与修复

### 1. OAuth exchange 的 delayed JSON 竞态

根因：

- `exchangeOAuth` 在 `apiFetch()` 返回后只检查一次 `pendingOAuth === flow`。
- `response.json()` 是独立异步边界；其等待期间用户可以启动新 flow。
- 旧 JSON 解析完成后没有重新确认身份，因而仍可写入 token/UI，并启动 account-b 或 comparison。

RED：

- 在 `index-html.test.mjs` 中把“Response 到达”和“JSON 解析完成”拆成两个可控阶段。
- 先让旧 exchange 进入等待 JSON，再启动新 account-a flow，最后返回旧 access token。
- 测试按预期失败：旧结果启动了 account-b，替换了当前 flow。

GREEN：

- 在 `await response.json()` 后、任何响应错误展示、token/UI 写入或 nextAction 设置前重新检查 `pendingOAuth !== flow` 并立即返回。
- delayed JSON 行为测试和原有 fetch 延迟竞态测试均通过。

### 2. 同步与管理日志泄漏

根因：

- `cron.ts` 将用户名插入自由文本，并把 rejection reason 直接传给 `console.warn`。
- 手动同步和 scheduled 同步将完整 Error 直接传给 `console.error`。
- 上游错误 message 可包含用户名、请求 URL、响应 body、token，Error 对象还可带 stack。
- 原有结构化 manage/health 日志虽不记录 message，但 `Error.name` 未限制，仍可被任意自由文本污染；嵌套 console 调用也会被危险调用扫描命中。

RED：

- 新增同步日志行为测试，传入包含 username、access token、refresh token、上游 body 的错误。
- 新增源码测试，要求 console 调用点不直接接收 err/error/reason/user/BANGUMI_USERS。
- 首次运行按预期因 `createSyncFailureLog` 尚不存在而失败。

GREEN：

- 增加最小 `createSyncFailureLog`，仅输出固定字段：`event`、`phase`、allowlist `kind`、数字 `upstream_status`、`at`。
- 错误类别仅允许 `BgmHttpError`、`BgmTimeoutError`、`BgmNetworkError`、`SyntaxError`、`TypeError`、`Error`，其他名称归类为 `Unknown`。
- manage/health 日志同步复用安全错误类别。
- 所有相关 console 调用仅输出 `JSON.stringify(log)`；不输出异常对象、message、stack、用户名、token 或 body。
- 行为测试与源码调用点测试通过；最终危险日志 regex 无匹配。

### 3. OAuth state 未来过期时间无上界

根因：

- `verifyOAuthState` 只验证 `exp > nowSeconds`，因此任何签名合法、远超五分钟的 state 都会被接受。

RED：

- 用 `createOAuthState(secret, purpose, now + 1000)` 创建合法签名 state，再在 `now` 验证。
- 该 state 的 exp 为验证时刻后 301 秒；测试按预期失败并返回有效 payload。

GREEN：

- 增加 `payload.exp <= nowSeconds + 300` 上界。
- 保留现有秒级边界：恰好未来 300 秒仍可接受，不扩大窗口。
- 新测试及原有有效、过期、篡改 state 测试通过。

### 4. OAuth callback 无 opener 时仍关闭

根因：

- 可选链只保护 `window.opener?.postMessage(...)`，后续 `window.close()` 无条件执行。
- 用户直接打开/粘贴 callback URL 时页面关闭，无法按 README 回退流程从地址栏复制 URL。

RED：

- 新增无 opener 的脚本行为测试，要求不关闭页面并显示固定手动复制提示。
- 测试按预期失败：`window.close()` 仍被调用。

GREEN：

- 只有 opener 存在时才向 `location.origin` postMessage 并关闭。
- 无 opener 时保持页面打开，仅揭示静态提示：“OAuth 回调已完成。请复制地址栏中的完整 URL，返回管理页手动粘贴。”
- 提示不拼接 code、state 或任何请求数据。
- opener 与无 opener 两条行为测试均通过。

## 修改文件

- `packages/worker/src/manage/index.html`
- `packages/worker/src/manage/index-html.test.mjs`
- `packages/worker/src/manage/security.ts`
- `packages/worker/src/manage/security.test.ts`
- `packages/worker/src/index.ts`
- `packages/worker/src/cron.ts`

README 无需修改：实现已恢复现有手动复制回调 URL 文档所描述的行为。

## 最终验证

1. `node --test packages/worker/src/manage/security.test.ts packages/worker/src/manage/index-html.test.mjs`
   - PASS：54 tests，54 pass，0 fail。
2. `OPENSPEC_TELEMETRY=0 /Users/ian/Desktop/Projects/BangumiTV/node_modules/.bin/openspec validate secure-management-api --strict`
   - PASS：`Change 'secure-management-api' is valid`。
3. `WRANGLER_LOG_PATH=/tmp/bangumitv-secure-management-final-fix1.log ./packages/worker/node_modules/.bin/wrangler deploy --dry-run --outdir /tmp/bangumitv-secure-management-final-fix1 --config packages/worker/wrangler.toml`
   - PASS：Wrangler 4.100.0 dry-run 完成，upload bundle 生成。
4. `git diff --check`
   - PASS：无输出。
5. 管理面危险模式扫描
   - PASS：无匹配；`rg` exit 1 表示未找到结果。
6. console error/user 危险调用扫描
   - PASS：无匹配；`rg` exit 1 表示未找到结果。

## 自审

- 四项 finding 均有独立、真实缺口对应的 RED，且失败原因与 reviewer 描述一致。
- 生产修改保持最小：一个 JSON 后 identity check、一个 state 上界、一个 callback 分支、一个小型结构化同步日志构造器。
- 未增加依赖、日志框架、KV key 或通用抽象。
- 未修改 plan、OpenSpec tasks、package.json、锁文件、README 或其他 change。
- 提交仅包含上述 6 个允许文件。
- 工作树中原有 `subagent-progress.md`、`task-4-report.md`、`task-5-report.md` 均未纳入提交。
- 本报告按要求保留为未提交文件。
- 未发现剩余 Critical、Important 或 Minor 顾虑。
