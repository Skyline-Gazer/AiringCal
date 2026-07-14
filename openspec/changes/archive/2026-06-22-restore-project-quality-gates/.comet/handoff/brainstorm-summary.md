# Brainstorm Summary

- Change: restore-project-quality-gates
- Date: 2026-06-22

## 确认的技术方案

### 图片策略
恢复 R2 图片管线，在单一 Worker 框架内完成。多 Worker 拆分（上传/缓存/反代分开）作为后续独立 change。

- **获取时机**：cron 同步时拉取封面图片写入 R2（batch 同步），不采用按需懒加载
- **限流控制**：对图片下载子请求做并发限制，避免单次 cron 内 CPU 超限
- **链路**：`cron.ts` → `bgm-client.downloadImage()` → `R2ImageStore.putOriginal()` → R2 bucket → `image/proxy.ts` 提供

### 测试策略
沿用 `node:test`（Node 原生测试），不引入新测试框架。

- 新增 `packages/shared/src/merger.test.ts`：覆盖 `merge()` 和 `primaryMerge()`
- 已有 7 个测试文件无需改动

### 包管理
- 根 `package.json` 添加 `packageManager: "pnpm@9.x"`
- 移除 `package-lock.json`
- `.gitignore` 移除 `pnpm-lock.yaml`，添加 `package-lock.json`
- CI 使用 `pnpm install --frozen-lockfile`

### CI 质量门
- 固定 pnpm 版本（从 `version: latest` 改为具体版本）
- 添加 `typecheck`、`test`、`build:check` 步骤，在部署前依次执行

### 死代码清理
- 删除 `data/calendar.json`（旧 Vercel 时代遗留）
- 清理 `merger.ts` 中 images 空占位逻辑，恢复真实 hash

### Env 类型
- 使用 `wrangler types` 生成 Env 类型替代手写 `interface Env`

### 文档
- 更新 README 移除虚假 R2 缓存声明，补充实际图片策略

## 关键取舍与风险

- [R2 管线恢复] Worker 子请求有 50ms CPU 硬限制，需限流控制并发数；封面图片只下载小尺寸
- [测试范围] 不追求行覆盖率，只覆盖高风险分支（merge、primaryMerge）
- [wrangler types] 生成的类型文件需纳入版本管理，每次修改 wrangler.toml 后需重新生成

## 测试策略

- `node:test` + `node:assert/strict`
- 新增 merger 测试：多账户合并、主账户保护、边界条件（空输入、单账户、全部 NSFW 隐藏）
- 新增图片限流逻辑测试
- CI 中 `pnpm test` 运行所有包的测试

## Spec Patch

无。现有 delta spec 已覆盖所有验收场景，无需补充。
