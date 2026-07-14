# Brainstorm Summary

- Change: simplify-frontend-deployment
- Date: 2026-06-21

## 确认的技术方案

**方案 B：构建期文本导入** — 扩展现有 Wrangler `[[rules]] type = "Text"` 规则覆盖 `.css` 和 `.js`，用标准模块导入替代 `assets.ts`。

具体步骤：
1. 在 `wrangler.toml` 中为 `.css` 和 `.js` 添加 Text 导入规则
2. 创建 3 个薄导入模块（`src/html.ts`、`src/css.ts`、`src/js.ts`），从 `public/` 直接导入内容
3. 删除 `packages/worker/src/assets.ts`
4. 更新 `packages/worker/src/index.ts` 的 import 来源

## 关键取舍与风险

- **取舍**：静态资源变更需重新部署 Worker（vs `[assets]` 可独立更新）
- **风险**：无显著风险。Wrangler Text 规则已是生产特性，项目当前已在使用（`.html` 规则）
- **可接受**：该项目前端仅 3 个文件 ~314 行，重新部署成本极低

## 测试策略

- 部署预览验证 Worker 返回的 HTML/CSS/JS 内容正确
- CI 检查确保占位符和资源路径有效
- dry-run 验证 bundle 包含导入的文本资源

## Spec Patch

无需要。现有 delta spec (`single-frontend-delivery/spec.md`) 已经覆盖了「HTML、JavaScript 和 CSS MUST 各自只有一个可编辑源码」的要求，Text 导入方案自然满足。
