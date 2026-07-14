## ADDED Requirements

### Requirement: 包管理器必须唯一
仓库 MUST 使用 pnpm 及其锁文件作为唯一依赖来源，CI MUST 使用 frozen lockfile。

#### Scenario: npm lockfile 被加入仓库
- **WHEN** 质量检查发现 `package-lock.json`
- **THEN** 检查失败并提示使用 pnpm 更新依赖

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权和同步输入验证 MUST 有可运行的自动测试。

#### Scenario: primary 保护被回归破坏
- **WHEN** 主账户失败后代码生成空快照
- **THEN** 测试失败

### Requirement: 类型和 Worker bundle 必须可验证
每次部署前 MUST 完成 TypeScript 类型检查和 Wrangler dry-run。

#### Scenario: Worker 绑定类型与配置漂移
- **WHEN** 代码引用未声明绑定或类型不匹配
- **THEN** 类型或 bundle 检查失败且不会部署

### Requirement: 声明能力必须可运行
README、架构文档、配置和代码中声明的外部能力 MUST 有完整运行路径；无法端到端工作的能力 MUST 被删除或明确标记为未提供。

#### Scenario: R2 图片链路没有生产者
- **WHEN** 同步流程不写入图片而前端仍依赖 R2 hash
- **THEN** 质量验收失败，必须恢复完整管线或删除该能力

### Requirement: CI 工具版本必须可复现
CI MUST 使用仓库声明的包管理器和依赖版本，不得用浮动 latest 替代锁文件。

#### Scenario: 新版 pnpm 发布
- **WHEN** 上游发布新的 pnpm 版本
- **THEN** 未修改仓库配置的部署仍使用已声明版本

### Requirement: 文档必须通过实现核对
README 和技术设计 MUST 与当前路由、绑定、同步行为及部署流程一致。

#### Scenario: 功能被删除
- **WHEN** 代码删除某项能力
- **THEN** 同一 change 内同步删除或修改相关文档说明
