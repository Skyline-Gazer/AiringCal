# Comet Design Handoff

- Change: simplify-frontend-deployment
- Phase: design
- Mode: compact
- Context hash: 9b2017dd734e084985b9726306953f7f13ea0fc57e94debc20e72c94d7719b3e

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/simplify-frontend-deployment/proposal.md

- Source: openspec/changes/simplify-frontend-deployment/proposal.md
- Lines: 1-25
- SHA256: fc6b1bbfb73f203a64a380b80b4ecd32774bfb7a20dd9e3014066c7db616644d

```md
## Why

项目同时维护 Worker 内联资源与 Pages 静态资源，两者已经发生漂移；Pages 入口还会把 `<WORKER_DOMAIN>` 占位符直接部署上线。重复入口增加故障面，却没有提供独立价值。

## What Changes

- **BREAKING**：收敛为一个正式前端发布入口，移除重复且失效的 Pages 部署链路。
- 建立 JS、CSS、HTML 的单一源码，Worker 响应从该源码生成或直接绑定，禁止手工复制。
- 修复当前无效 CSS 和页面资源路径。
- 更新 CI、README 与架构文档，使部署域名、前端接入方式和静态资源来源一致。
- 添加最小构建检查，阻止占位域名和资源漂移再次进入部署。

## Capabilities

### New Capabilities

- `single-frontend-delivery`: 单一前端发布入口、资源一致性和部署前验证。

### Modified Capabilities

无。

## Impact

影响 `public/`、Worker 静态资源处理、`assets.ts`、GitHub Actions、README 和迁移设计文档。现有 Pages 项目可保留但不再由仓库部署。
```

## openspec/changes/simplify-frontend-deployment/design.md

- Source: openspec/changes/simplify-frontend-deployment/design.md
- Lines: 1-39
- SHA256: fc379f3aaf25edea890d20b9d549975643d0ace4c97321ce0d880ba60a900d0f

```md
## Context

Worker 通过 `assets.ts` 内联一份前端，CI 又部署 `public/` 到 Pages。两份源码已经漂移，Pages HTML 还保留无效占位域名。

## Goals / Non-Goals

**Goals:**

- 只保留 Worker 作为正式页面、资源和 API origin。
- 让前端文件成为唯一源码并可在部署前验证。

**Non-Goals:**

- 不重做 Widget UI。
- 不保留无实际需求的独立 Pages 产品。

## Decisions

- 删除 GitHub Actions 中 Pages provisioning 和 deploy 步骤。
- 保留 `public/` 作为可读源码，通过 Wrangler 静态资源能力或最小构建导入交付；不再维护 `assets.ts` 大字符串副本。
- 所有默认配置使用 `window.location.origin`，外部嵌入仍允许显式 `apiUrl`。
- 使用现有工具或极小脚本检查占位符与资源语法，不新增大型构建框架。

## Risks / Trade-offs

- [旧 Pages URL 停止更新] → README 明确 Worker URL 为唯一正式入口；需要时可在 Cloudflare 侧做重定向。
- [Wrangler 资源配置调整] → dry-run 验证 bundle 和静态资源绑定。

## Migration Plan

先让 Worker 直接交付单一源码并验证，再删除 Pages CI 步骤。回滚只需恢复旧 Worker 资源交付，不依赖 Pages 数据。

## Resolved Decisions (Design Doc)

选择构建期文本导入方案。详见 `docs/superpowers/specs/2026-06-21-frontend-asset-delivery-design.md`。

- 扩展 wrangler.toml Text 规则覆盖 `.css` 和 `.js`
- 新建 3 个薄导入模块（html.ts/css.ts/js.ts）替代 `assets.ts`
- 不采用 Wrangler `[assets]` 方案，避免 Hono 路由架构重构
```

## openspec/changes/simplify-frontend-deployment/tasks.md

- Source: openspec/changes/simplify-frontend-deployment/tasks.md
- Lines: 1-16
- SHA256: 7345d00cef7d070cacce78dab14469bd0c1fc27ebbea91773fc8ce8d423c59b6

```md
## 1. 单一资源来源

- [ ] 1.1 选择并配置 Worker 的静态资源交付方式
- [ ] 1.2 删除 `assets.ts` 中的前端副本并统一 HTML/JS/CSS 源码
- [ ] 1.3 修复 CSS 语法和资源相对路径

## 2. 部署收敛

- [ ] 2.1 删除 Pages 资源创建和部署步骤
- [ ] 2.2 添加占位符、资源语法和 Wrangler dry-run 检查
- [ ] 2.3 验证 Worker 首页、JS、CSS 和 API 使用同一 origin

## 3. 文档

- [ ] 3.1 更新 README 的部署和嵌入说明
- [ ] 3.2 修正迁移设计中的 Pages 与重复资源描述
```

## openspec/changes/simplify-frontend-deployment/specs/single-frontend-delivery/spec.md

- Source: openspec/changes/simplify-frontend-deployment/specs/single-frontend-delivery/spec.md
- Lines: 1-36
- SHA256: 73e481a36989addada9f84b736823a747a96885d2fd9ced0fe6b50564765b218

```md
## ADDED Requirements

### Requirement: 生产环境只有一个前端发布入口
系统 MUST 通过 Worker 提供正式页面与静态资源，CI 不得再部署第二套 Pages 前端。

#### Scenario: 推送 dev 分支
- **WHEN** 部署工作流成功执行
- **THEN** 只发布 Worker 且正式页面从 Worker 域名可访问

### Requirement: 前端资源必须只有一个源码
HTML、JavaScript 和 CSS MUST 各自只有一个可编辑源码，构建或 Worker 绑定负责交付，不得手工复制到第二个 TypeScript 字符串。

#### Scenario: 修改 Widget JavaScript
- **WHEN** 开发者修改 JavaScript 源文件
- **THEN** Worker 返回相同版本且无需同步编辑另一份副本

### Requirement: 部署不得包含占位配置
部署检查 MUST 拒绝包含 `<WORKER_DOMAIN>` 等未解析占位符的正式资源。

#### Scenario: 页面仍含占位域名
- **WHEN** CI 检查前端资源
- **THEN** 工作流失败且不会部署

### Requirement: 静态资源必须语法有效
HTML、JavaScript 和 CSS MUST 通过最小构建检查，资源路径必须在 Worker 域名下正确解析。

#### Scenario: CSS 存在孤立声明
- **WHEN** CSS 无法被检查器解析为有效样式表
- **THEN** 检查失败且不会部署

### Requirement: 文档必须描述唯一入口
README 和架构文档 MUST 只说明当前有效的 Worker 部署及前端接入方式。

#### Scenario: 用户按 README 部署
- **WHEN** 用户完成文档中的部署步骤
- **THEN** 页面和 API 使用同一个有效 Worker origin
```

