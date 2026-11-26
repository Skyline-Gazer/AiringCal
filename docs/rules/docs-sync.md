# 文档同步与发版约束

> 规则入口：[`CLAUDE.md`](../../CLAUDE.md) / [`AGENTS.md`](../../AGENTS.md)
> 此文件是完整规则正文。

## 零、修改前验证（最高优先级）

**修改任何 CLI 命令、配置参数、API 调用、第三方库用法之前，必须先查文档或源码验证有效性，禁止凭记忆或猜测。**

### 可用验证渠道（按优先级）

| 优先级 | 渠道 | 适用场景 |
|--------|------|---------|
| 1 | **本地命令** `--help` / `--version` | CLI flag、子命令、配置 key 是否存在 |
| 2 | **本地 API 参考** [`docs/example/api/bgm-api.json`](../example/api/bgm-api.json) | bgm.tv API 接口（路径、请求方法、参数、响应 schema）。**修改任何与 bgm.tv API 交互的代码前必须先查此文件** |
| 3 | **本地项目文档与源码** | 搜索项目内 `docs/`、`packages/`、`apps/`、`scripts/` 中的实现与类型定义 |
| 4 | **联网搜索 / 官方文档** | 以上渠道均无法确认时，查阅官方文档 |

### bgm.tv API 约束（强制）

**任何涉及 bgm.tv API 调用的新增/修改，必须先查阅 [`docs/example/api/bgm-api.json`](../example/api/bgm-api.json)（bgm.tv OpenAPI 规范），确认：**
1. 端点路径和方法是否存在
2. 请求参数和响应 schema 是否正确
3. 认证方式（Bearer / OptionalBearer）是否匹配
4. 禁止凭记忆编造不存在的 API 端点

## 一、提交纪律

**每次完成一个原子动作（fix / refactor / feat / chore / docs）之后必须保持提交原子性与可审查性。**

- commit message 遵循 conventional commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`）
- **除自动生成的 merge commit 外，每个人工或 agent 创建的 commit 都必须包含结构化正文；只有标题、没有正文的 commit 不允许提交。**

正文至少使用以下结构；某项确实不适用时必须写明 `N/A` 及原因，不得直接省略：

```text
<type>(<scope>): <简洁标题>

Business context:
- 为什么需要本次变更，以及关联的 task / issue / review finding。

Expected behavior:
- 修改后的业务行为，以及明确不得改变的行为。

Acceptance criteria:
- reviewer 可以逐项核验的完成条件。

Constraints and edge cases:
- 需要考虑的边界、安全、兼容性和明确排除范围。

Verification:
- 实际执行的命令与结果。
- 未执行的验证、原因及仍然存在的 gate。
```

附加约束：

- `Verification` 只能记录真实执行结果；不得把普通单元测试或模拟器测试描述成真实线上外部云厂商验收。
- 测试未增加或未修改时，必须写 `no-tests: <reason>`，说明为什么行为不受影响；不得只写 `no-tests`。
- 禁止在 commit title/body、PR 描述或 review 回复中写入 token、DSN、数据库连接串、webhook、R2 credential 或其他 secret。

## 二、文档随代码同步更新

**任何修改了代码的 commit，如果涉及以下文档覆盖的范围，必须在同一 commit 或紧随其后的 `docs:` commit 中更新对应文档：**

| 变动类型 | 需检查的文档 |
|---------|------------|
| 新增/修改只读 API 端点或 Widget 参数 | [`README.md`](../../README.md)、[`README.zh-CN.md`](../../README.zh-CN.md)、[`docs/API_AND_WIDGET.md`](../API_AND_WIDGET.md)、[`docs/API_AND_WIDGET.zh-CN.md`](../API_AND_WIDGET.zh-CN.md) |
| 新增/修改部署向导、环境变量或操作模式 | [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md)、[`docs/DEPLOYMENT.zh-CN.md`](../DEPLOYMENT.zh-CN.md) |
| 架构或包职责变更 | [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)、[`docs/README.md`](../README.md) |
| Portable Writer CLI 或退出码变更 | [`apps/node-jobs/docs/operator-contract.md`](../../apps/node-jobs/docs/operator-contract.md) |

**原则：代码即文档。不允许代码实现与文档描述不一致。**

## 三、发版文档审计

**发版前必须执行完整文档审计。审计清单：**

1. **端点审计** — 遍历所有 API 路由，逐一核对 [`docs/API_AND_WIDGET.md`](../API_AND_WIDGET.md) 与 [`README.md`](../../README.md) 是否列出且描述正确
2. **环境变量与命令审计** — 比对 `wrangler.toml`、`.github/workflows/portable-writer.yml`、`scripts/setup-wizard.mjs` 与 [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) 是否一致
3. **中英文对等审计** — 确认 `README.md` / `README.zh-CN.md`、`docs/DEPLOYMENT.md` / `docs/DEPLOYMENT.zh-CN.md`、`docs/API_AND_WIDGET.md` / `docs/API_AND_WIDGET.zh-CN.md` 语义完全对齐
4. **链接与截图审计** — 确认所有 Markdown 相对路径链接与 `docs/assets/*.png` 截图真实存在且已脱敏
5. **禁止前瞻内容** — 用户面文档中**不得包含尚未实现的特性描述、预留参数说明、或 "TODO/待实现" 标记**

## 四、文件职责

| 文件 | 职责 |
|------|------|
| [`AGENTS.md`](../../AGENTS.md) / [`CLAUDE.md`](../../CLAUDE.md) | 规则入口指针，指向本文件 |
| [`START_HERE_FOR_AI.md`](../../START_HERE_FOR_AI.md) | AI Agent 快速导航入口 |
| [`docs/rules/docs-sync.md`](docs-sync.md) | 本规则完整正文 |
| [`README.md`](../../README.md) / [`README.zh-CN.md`](../../README.zh-CN.md) | 双语产品主文档 |
| [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) / [`docs/DEPLOYMENT.zh-CN.md`](../DEPLOYMENT.zh-CN.md) | 双语权威部署与更新指南 |
| [`docs/API_AND_WIDGET.md`](../API_AND_WIDGET.md) / [`docs/API_AND_WIDGET.zh-CN.md`](../API_AND_WIDGET.zh-CN.md) | 双语 HTTP 只读 API 与 Widget 嵌入文档 |
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | 系统架构与安全隔离说明 |
