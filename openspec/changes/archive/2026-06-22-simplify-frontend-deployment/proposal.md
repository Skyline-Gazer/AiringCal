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
