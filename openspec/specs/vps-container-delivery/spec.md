# vps-container-delivery Specification

## Purpose
TBD - created by archiving change migrate-data-plane-to-vps. Update Purpose after archive.
## Requirements
### Requirement: production image 必须最小且加固
production image MUST 使用官方最新 `node:alpine` multi-stage build，只包含 Node runtime、production dependencies、应用产物、CA certificates、最小 PostgreSQL client 和运行库，并以非 root、只读 root filesystem、无公网端口和最小 capabilities 运行。

#### Scenario: 扫描 production image
- **WHEN** CI 检查已构建的 production target
- **THEN** image 不包含源码、dev dependencies、编译器、git、curl、Python、编辑器、jq 或 DNS 调试包

### Requirement: debug 工具必须隔离到手动 target
debug target MUST 从 production 扩展并只添加经 Alpine 包索引验证的 HTTPS、DNS、TCP、进程、网络和 JSON 排障工具；production Compose MUST NOT 引用 debug image。

#### Scenario: 手动构建 debug image
- **WHEN** 操作者触发 debug workflow
- **THEN** GHCR 发布 `<git-sha>-debug` 且 production SHA image 内容不变化

### Requirement: GHCR 交付必须可追溯
CI MUST 记录实际 Node、Alpine、pnpm、base digest 和 git SHA，并发布不可覆盖的完整 git-SHA production tag；VPS Compose MUST 使用该 SHA 而不是浮动标签。

#### Scenario: 上游 node:alpine 更新
- **WHEN** 相同源代码在新的 base digest 上需要重建
- **THEN** 变更通过新的 reviewed commit 产生新 SHA image，旧 SHA image 不被覆盖

### Requirement: VPS 发布必须人工批准
第一版 MUST 由运维手工更新 Compose SHA、拉取 image、运行 shadow sync 和确认切流；GitHub Actions 不得持有 VPS SSH 部署权限。

#### Scenario: GHCR production build 完成
- **WHEN** 新 SHA image 已推送
- **THEN** VPS 在人工操作前继续运行原 SHA image
