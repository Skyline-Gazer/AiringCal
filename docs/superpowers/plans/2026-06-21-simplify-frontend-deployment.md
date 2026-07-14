---
change: simplify-frontend-deployment
design-doc: docs/superpowers/specs/2026-06-21-frontend-asset-delivery-design.md
base-ref: 767bade07a73c8f897c8ade7fcffb454a26150d7
archived-with: 2026-06-22-simplify-frontend-deployment
---

# Simplify Frontend Deployment — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端资源交付收敛为 Worker 单一入口，消除 `assets.ts` 漂移副本和 Pages 独立部署链路。

**Architecture:** 保持单 Worker（Hono 路由）。扩展 Wrangler Text 规则覆盖 `.css` 和 `.js`，以构建期文本导入替代 `assets.ts` 内联大字符串。删除 GitHub Actions 中 Pages Provisioning 和 Deploy 步骤。`public/` 保留为唯一源码目录。

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Wrangler 4, esbuild

## Global Constraints

- 不新增 npm 依赖或外部构建工具。
- `public/index.html` 使用 `window.location.origin` 自动检测 API 地址，不再硬编码占位域名。
- 所有前端资源（HTML/CSS/JS）必须从同一 Worker origin 交付。
- 回滚只需恢复旧 Worker 资源交付，不依赖 Pages 数据。
- 迁移期间 `assets.ts` 与新建导入模块可共存，验证通过后再删除。

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 1: 扩展 Wrangler Text 规则

**Files:**
- Modify: `packages/worker/wrangler.toml`

- [x] **Step 1: 扩展 Text 规则 globs**

将现有的 `.html` Text 规则扩展为覆盖 `.css` 和 `.js`：

```toml
[[rules]]
type = "Text"
globs = ["**/*.html", "**/*.css", "**/*.js"]
fallthrough = true
```

变更理由：设计文档选择「构建期文本导入」方案，通过 Wrangler Text rules 让 Worker bundle 直接导入 `.css` 和 `.js` 文件为字符串，无需独立静态资源部署。

- [x] **Step 2: 提交**

```bash
git add packages/worker/wrangler.toml
git commit -m "feat: extend Wrangler Text rules to cover .css and .js"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 2: 修复 public/ 源码问题

**Files:**
- Modify: `public/index.html`
- Modify: `public/src/bangumi.css`

- [x] **Step 1: 修复 index.html 中的占位域名**

`public/index.html` 当前包含硬编码占位符：

```html
<script>
  const bgmConfig = {
    apiUrl: "https://<WORKER_DOMAIN>",
    quote: "生命不止，追番不息！"
  }
</script>
```

替换为自动检测方式（与 `assets.ts` 一致）：

```html
<script>
  const bgmConfig = {
    quote: "生命不止，追番不息！"
  }
</script>
```

前端 JS 中 `config.apiUrl || window.location.origin` 会自动回退到当前 origin。

- [x] **Step 2: 修复 bangumi.css 缺失的 selector 前缀**

`public/src/bangumi.css` 第 1 行以 `  width: 100%;` 开头，缺少容器选择器。补充 `.bgm-container {`：

```css
.bgm-container {
  width: 100%;
  padding: 20px 0;
}
```

- [x] **Step 3: 提交**

```bash
git add public/index.html public/src/bangumi.css
git commit -m "fix: remove placeholder domain in HTML and add missing CSS selector"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 3: 创建薄导入模块

**Files:**
- Create: `packages/worker/src/html.ts`
- Create: `packages/worker/src/css.ts`
- Create: `packages/worker/src/js.ts`

- [x] **Step 1: 创建 html.ts**

```ts
import html from '../../public/index.html'
export default html
```

- [x] **Step 2: 创建 css.ts**

```ts
import css from '../../public/src/bangumi.css'
export default css
```

- [x] **Step 3: 创建 js.ts**

```ts
import js from '../../public/src/bangumi.js'
export default js
```

这些模块是薄胶水层，将 `public/` 源文件通过 Wrangler Text 规则转为 TypeScript 可导入的字符串。`assets.ts` 仍存在，此步骤可安全回滚。

- [x] **Step 4: 提交**

```bash
git add packages/worker/src/html.ts packages/worker/src/css.ts packages/worker/src/js.ts
git commit -m "feat: create thin import modules for HTML, CSS, JS"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 4: 更新 Worker 路由

**Files:**
- Modify: `packages/worker/src/index.ts`

- [x] **Step 1: 替换 import 语句**

将：

```ts
import { INDEX_HTML, BANGUMI_JS, BANGUMI_CSS } from './assets'
```

替换为：

```ts
import indexHtml from './html'
import bangumiJs from './js'
import bangumiCss from './css'
```

- [x] **Step 2: 更新路由引用**

将路由中的变量名同步更新：

```ts
app.get('/', () => {
  return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
})

app.get('/src/bangumi.js', () => {
  return new Response(bangumiJs, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } })
})

app.get('/src/bangumi.css', () => {
  return new Response(bangumiCss, { headers: { 'Content-Type': 'text/css; charset=utf-8' } })
})
```

- [x] **Step 3: 提交**

```bash
git add packages/worker/src/index.ts
git commit -m "refactor: switch from assets.ts inline strings to text-import modules"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 5: 删除 assets.ts

**Files:**
- Delete: `packages/worker/src/assets.ts`

- [x] **Step 1: 删除文件并验证**

确认 index.ts 已无 `'./assets'` 引用后，删除 `packages/worker/src/assets.ts`。

- [x] **Step 2: 提交**

```bash
git rm packages/worker/src/assets.ts
git commit -m "chore: remove outdated assets.ts inline copy"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 6: 更新 CI/CD — 删除 Pages 部署链路

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [x] **Step 1: 删除 Pages provisioning 步骤**

在 "Provision Cloudflare resources" 步骤中删除：

```bash
npx wrangler pages project create bangumi-tv --production-branch dev || echo "Pages project already exists"
```

- [x] **Step 2: 删除 Pages deploy 步骤**

删除整个 "Deploy Pages" 步骤块：

```yaml
- name: Deploy Pages
  uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CF_API_TOKEN }}
    accountId: ${{ secrets.CF_ACCOUNT_ID }}
    command: pages deploy ../../public/ --project-name=bangumi-tv --commit-dirty=true
    workingDirectory: packages/worker
```

- [x] **Step 3: 添加部署前验证步骤**

在 "Deploy Worker" 之前添加 Wrangler dry-run 检查，阻止占位域名和资源漂移：

```yaml
- name: Validate assets before deploy
  working-directory: packages/worker
  run: |
    # 检查占位域名未进入 public/
    if grep -r '<WORKER_DOMAIN>' ../../public/; then
      echo "ERROR: Placeholder <WORKER_DOMAIN> found in public/ files" >&2
      exit 1
    fi
    # 检查 CSS 语法完整性（简单检验：CSS 文件是否以 } 结尾）
    for f in ../../public/src/*.css; do
      last_char=$(tail -c 1 "$f")
      if [ "$last_char" != "}" ]; then
        echo "WARNING: $f may have incomplete CSS syntax" >&2
      fi
    done
    # Wrangler dry-run 验证 bundle
    npx wrangler deploy --dry-run --outdir dist-check
    echo "Validation passed"
```

- [x] **Step 4: 提交**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: remove Pages deployment, add pre-deploy validation"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 7: 文档更新

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-21-frontend-asset-delivery-design.md`（更新任务状态）
- Modify: `openspec/changes/simplify-frontend-deployment/tasks.md`（勾选完成项）

- [x] **Step 1: 更新 README 部署说明**

- 将正式入口统一为 Worker URL，移除 Pages URL 引用
- 更新嵌入代码示例，确保使用 `window.location.origin`
- 说明单一部署入口的变更

- [x] **Step 2: 更新设计文档中的迁移状态**

在 `2026-06-21-frontend-asset-delivery-design.md` 中确认迁移步骤已完成。

- [x] **Step 3: 勾选 OpenSpec tasks**

根据实际完成情况勾选 `openspec/changes/simplify-frontend-deployment/tasks.md` 中的 checklist 项。

- [x] **Step 4: 提交**

```bash
git add README.md docs/superpowers/specs/2026-06-21-frontend-asset-delivery-design.md openspec/changes/simplify-frontend-deployment/tasks.md
git commit -m "docs: update README and design doc after simplify-frontend-deployment"
```

archived-with: 2026-06-22-simplify-frontend-deployment
---

### Task 8: 端到端验证

- [x] **Step 1: 本地 dev 模式验证**

```bash
cd packages/worker && npx wrangler dev
```

- 访问 `http://localhost:8787/` → 返回 HTML 页面
- 访问 `http://localhost:8787/src/bangumi.js` → 返回 JS 内容
- 访问 `http://localhost:8787/src/bangumi.css` → 返回 CSS 内容
- 确认页面加载无 404 资源
- 确认 API 接口正常工作（`/api/health`、`/api/collections`）

- [x] **Step 2: 验证单一 origin**

所有前端资源（HTML、JS、CSS）均从同一 Worker origin 返回，无跨域请求。

- [x] **Step 3: 验证 CI dry-run 通过**

确认 `npx wrangler deploy --dry-run` 成功，无占位域名泄漏。

- [x] **Step 4: 更新 tasks.md 最终状态**

确认 `openspec/changes/simplify-frontend-deployment/tasks.md` 中所有项已勾选。

archived-with: 2026-06-22-simplify-frontend-deployment
---

## 回滚方案

1. **Worker 资源交付回滚**：恢复 `index.ts` 中 `'./assets'` 的 import，重新部署 Worker，不依赖 Pages。
2. **CI 回滚**：恢复 `deploy.yml` 中被删除的 Pages provisioning 和 deploy 步骤。
3. **public/ 源码回滚**：使用 `git revert` 恢复占位域名和 CSS selector 变更。

回滚不破坏现有数据（KV、R2）或用户状态。
