# 文档同步与发版约束

> 规则入口：`CLAUDE.md` / `AGENTS.md`
> 此文件是完整规则正文。

## 零、修改前验证（最高优先级）

**修改任何 CLI 命令、配置参数、API 调用、第三方库用法之前，必须先查文档验证有效性，禁止凭记忆或猜测。**

违反此规则的典型案例：
- 给 `wrangler deploy` 加 `--no-triggers` 参数，实际该参数不存在，wrangler 静默忽略后仍尝试部署 trigger
- 使用 `wrangler triggers deploy` 子命令，实际该命令只配合 `versions upload` 使用，不适用于 `deploy`

### 可用验证渠道（按优先级）

| 优先级 | 渠道 | 适用场景 |
|--------|------|---------|
| 1 | **本地命令** `--help` / `--version` | CLI flag、子命令、配置 key 是否存在 |
| 2 | **本地 API 参考** `docs/example/api/bgm-api.json` | bgm.tv API 接口（端路径、请求方法、参数、响应 schema）。**修改任何与 bgm.tv API 交互的代码前必须先查此文件** |
| 3 | **Context7 MCP** (`mcp__context7__query-docs`) | 库/框架/SDK/CLI API 文档（Wrangler、Hono、Cloudflare Workers 等） |
| 4 | **本地项目文档** | 搜索项目内 `docs/`、`*.md`、design docs 中的相关说明 |
| 5 | **源代码类型定义** | `grep` 项目 `node_modules/` 或类型声明文件确认签名 |
| 6 | **联网搜索** | 以上渠道均无法确认时，使用 WebSearch 或 WebFetch 查官方文档 |

### bgm.tv API 约束（强制）

**任何涉及 bgm.tv API 调用的新增/修改，必须先查阅 `docs/example/api/bgm-api.json`（bgm.tv OpenAPI 规范），确认：**
1. 端点路径和方法是否存在
2. 请求参数和响应 schema 是否正确
3. 认证方式（Bearer / OptionalBearer）是否匹配
4. 禁止凭记忆编造不存在的 API 端点（如 `/v0/user/me` 写成 `/v0/me2`）

### 必须执行的验证步骤

| 场景 | 必须先执行的验证命令 |
|------|---------------------|
| 新增/修改 CLI 命令参数 | `--help` → 无对应 flag 则不可使用 |
| 新增/修改 wrangler 配置 | `--help` + Context7 查 Wrangler 文档确认 TOML key |
| 使用 Cloudflare Workers API | Context7 查 Workers docs + `grep` `worker-configuration.d.ts` |
| 使用第三方库 API | 本地 types + Context7 查对应库文档 |
| 修改 CI/CD 流程 | Context7 查 GitHub Actions 文档 + 现有 workflow 参照 |

### 验证门禁

**每当你打算写下以下内容时必须停止，先验证再写：**

1. 一个你没见过的 CLI flag（如 `--no-triggers`、`--some-flag`）
2. 一个你不确定存在性的 API 方法（如 `caches.default`）
3. 一个你不确定语法对的配置项（如 `[triggers]` 的 `crons` 字段格式）
4. 一个你不确定类型的函数参数

**验证通过标准：**
- CLI flag → `--help` 输出中有该 flag
- API 方法 → 类型定义文件中有对应签名
- 配置项 → 官方文档中有对应章节

## 一、提交纪律

**每次完成一个原子动作（fix / refactor / feat / chore）之后必须立即 commit 并 push，不得积攒。**

- 一条 commit 对应一个逻辑变更
- commit message 遵循 conventional commits（`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`）
- commit 之后立即 `git push`

## 二、文档随代码同步更新

**任何修改了代码的 commit，如果涉及以下文档覆盖的范围，必须在同一 commit 或紧随其后的 `docs:` commit 中更新对应文档：**

| 变动类型 | 需检查的文档 |
|---------|------------|
| 新增/修改 API 端点 | README.md 端点说明、环境变量表 |
| 新增/修改环境变量 | README.md 环境变量说明 |
| 新增/修改 Worker 配置 | README.md 及相关架构文档 |
| 调试/日志/错误处理逻辑变更 | README.md 调试与日志章节 |
| 架构变更（Worker 拆分、绑定变更） | README.md + `docs/superpowers/specs/` 下对应设计文档 |
| CI/CD 流程变更 | README.md 部署说明 |

**原则：代码即文档。不允许代码实现与文档描述不一致。**

## 三、发版文档审计

**发版前必须执行完整文档审计。审计清单：**

1. **端点审计** — 遍历所有 API 路由，逐一核对 README 是否列出且描述正确
2. **环境变量审计** — 比对 `wrangler.toml` / `wrangler.*.toml` 中所有 `[vars]` 和 CI secrets 与 README 表格是否一致
3. **Worker 架构审计** — 确认所有 Worker（含多 Worker 拆分）的职责描述与实际入口文件一致
4. **日志事件审计** — 核对 README 中日志事件速查表与代码中所有 `console.log/warn/error` 的 `event` 字段一致
5. **配置审计** — 核对 README 中的配置说明与实际 TOML/CI 配置匹配
6. **禁止前瞻内容** — README 和设计文档中**不得包含尚未实现的特性描述、预留参数说明、或 "TODO/待实现" 标记**

**审计不通过不得发版。发现问题先修代码或文档，再重新审计，通过后方可发版。**

## 四、文件职责

| 文件 | 职责 |
|------|------|
| `CLAUDE.md` | 规则入口指针，指向本文件 |
| `AGENTS.md` | 同上，供 subagent 感知 |
| `docs/rules/docs-sync.md` | 本规则完整正文 |
| `README.md` | 用户面文档，发版审计主对象 |
| `docs/superpowers/specs/` | 设计文档，需与实现保持一致 |
