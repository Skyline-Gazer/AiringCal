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
