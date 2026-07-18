# Task 2 Report: Token 内存生命周期与公开 HTML 安全头

## 状态

- Task 2 实现完成，严格遵循 RED → GREEN。
- Token 生命周期回归已确认：页面初始化删除 `sync-tokenA` / `sync-tokenB`，生产 Widget 不读取或写入这两个 sessionStorage key；该生产代码由前置 Task 1 commit `c08b2e3` 提供，本任务保留并复验。
- Frontend 仅对 HTML 响应设置 CSP、nosniff、frame/base 限制；JS/CSS 未套 HTML CSP。
- Operation HTML 对完整序列化 JSON 转义；JSON `{ ok: true, operation }` 契约保持不变且未套 HTML CSP。

## RED 证据

首次在沙箱内运行完整命令因 `tsx` 创建 IPC socket 被拒绝（`listen EPERM`），属于环境错误，不计为有效 RED。随后在获准的沙箱外环境取得有效 RED：

1. `CI=true pnpm -F @airing-cal/frontend-worker test`
   - 结果：6 pass / 1 fail。
   - 有效失败：`frontend-worker protects HTML responses without applying HTML CSP to assets`，预期 `nosniff`，实际为 `null`。
2. `CI=true pnpm -F @airing-cal/sync-worker test`
   - 结果：32 pass / 1 fail。
   - 有效失败：`operation check escapes HTML while preserving the JSON response contract`，预期 `nosniff`，实际为 `null`；生产分支同时仍直接把 `JSON.stringify` 插入 `<pre>`。
3. Widget RED 前置条件已由 Task 1 实现，因此本任务新增/确认的 Token 生命周期回归立即通过：23 / 23；未伪造无效失败。

## GREEN 实现

- `apps/frontend-worker/src/index.ts`
  - 增加 HTML 专用 response helper。
  - 设置 CSP、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`。
  - 保持静态 JS/CSS 通用响应 helper 不变。
- `apps/frontend-worker/src/frontend-worker.test.ts`
  - 验证 HTML 安全头与 JS/CSS 无 HTML CSP。
- `apps/sync-worker/src/index.ts`
  - 对 operation 的完整格式化 JSON 编码 `&`、`<`、`>` 后放入 `<pre>`。
  - HTML 使用 `default-src 'none'`、frame/base 限制、nosniff、DENY。
  - JSON 内容协商分支不变。
- `apps/sync-worker/src/sync-worker.test.ts`
  - 使用 `</pre><script>` 恶意 operation 同时验证 HTML 不注入、HTML 安全头、JSON 精确结构与 JSON 无 HTML CSP。

## GREEN 与交付验证

- `pnpm -F @airing-cal/widget generate`：通过，生成产物无漂移。
- `CI=true pnpm -F @airing-cal/widget test && CI=true pnpm -F @airing-cal/frontend-worker test && CI=true pnpm -F @airing-cal/sync-worker test`：23 + 7 + 33，合计 63 / 63 通过。
- `CI=true pnpm -F @airing-cal/widget typecheck`：通过。
- `CI=true pnpm -F @airing-cal/frontend-worker typecheck`：通过。
- `CI=true pnpm -F @airing-cal/sync-worker typecheck`：通过。
- `git diff --check`：通过。

## 文件范围

- `apps/frontend-worker/src/index.ts`
- `apps/frontend-worker/src/frontend-worker.test.ts`
- `apps/sync-worker/src/index.ts`
- `apps/sync-worker/src/sync-worker.test.ts`
- `.superpowers/sdd/task-2-report.md`

未修改 plan、OpenSpec tasks、progress 或 README；协调器已有的 `.comet/subagent-progress.md` 脏改不纳入本任务提交。

## 自审与顾虑

- CSP 只加在 HTML，未污染 JSON、JS、CSS。
- Frontend 页面现有 DOM 动态样式依赖 inline style，因此 CSP 仅为 `style-src` 保留 `'unsafe-inline'`；脚本仍只允许同源且没有 `'unsafe-inline'`。
- Operation CSP 为 `default-src 'none'`，页面无 JS/CSS 依赖。
- `escapeHtml` 只编码 JSON 在 HTML 文本上下文中有语义的 `&<>`，与 brief 指定实现一致；双引号留在 `<pre>` 文本中不会形成属性或脚本上下文。
- Token 生产修改来自前置 Task 1 commit，本任务提交中不会重复制造无意义变更，但 23 项 Widget 测试已覆盖并通过。

## Commit

- Message：`fix: confine tokens and harden public html`
- SHA：本报告与实现处于同一原子 commit，提交对象无法自引用自身 SHA；最终 SHA 记录在父协调器报告与本任务返回值中。
