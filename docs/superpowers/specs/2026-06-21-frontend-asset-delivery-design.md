---
comet_change: simplify-frontend-deployment
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-22-simplify-frontend-deployment
status: final
---

# Frontend Asset Delivery Design

## Context

Worker 目前通过 `packages/worker/src/assets.ts` 将前端资源（HTML/CSS/JS）内联为 TypeScript 字符串。源文件位于 `public/`，但两份副本已经漂移。需要选择一种方式让 Worker 交付单一源文件。

## Decision: Build-time Text Import

选择 **构建期文本导入（Wrangler Text rules）** 替代 Wrangler `[assets]` 静态托管方案。

### 理由

| 维度 | Text Import | `[assets]` |
|------|------------|------------|
| 改动文件数 | 6（配置 + 3 模块 + 路由 + 删除旧文件） | 5+（配置 + 路由重构 + 删除旧文件） |
| 架构影响 | 极小 — 保持现有路由模式 | 大 — 需要协调 Hono 路由与静态文件 fallthrough |
| 已支持程度 | 已有 `.html` Text 规则，只需扩展 | 需要新增配置块 |
| 可维护性 | 导入即用，直观 | 需要理解 Wrangler assets 与 Worker 路由的交互 |
| 部署单元 | 单一 Worker bundle | Worker + 静态资源独立部署 |

### 实现方案

1. **wrangler.toml** — 扩展 Text 规则覆盖 `.css` 和 `.js`：
   ```toml
   [[rules]]
   type = "Text"
   globs = ["**/*.html", "**/*.css", "**/*.js"]
   fallthrough = true
   ```

2. **新建 3 个导入模块**，替代 `assets.ts`：
   - `packages/worker/src/html.ts` — `import html from '../../public/index.html'`
   - `packages/worker/src/css.ts` — `import css from '../../public/src/bangumi.css'`
   - `packages/worker/src/js.ts` — `import js from '../../public/src/bangumi.js'`

3. **删除** `packages/worker/src/assets.ts`

4. **更新** `packages/worker/src/index.ts` — 将 import 从 `'./assets'` 改为 `'./html'`、`'./css'`、`'./js'`

### 迁移计划

1. ✅ 先添加 Text 规则和导入模块（此时 `assets.ts` 仍存在，可回滚）
2. ✅ 验证 dev 模式下 Worker 能正确导入并响应
3. ✅ 删除 `assets.ts` 并更新 `index.ts` import
4. ✅ 更新 CI 确认 Pages 部署步骤已被删除（属于 build 阶段任务）

### 完成状态

所有迁移步骤已于 `simplify-frontend-deployment` 变更中完成。Worker 作为单一部署入口，前端资源通过 Wrangler Text rules 构建期导入，不再依赖 Cloudflare Pages。
