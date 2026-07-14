## Why

仓库缺少测试、类型检查和部署前质量门，且 pnpm/npm 状态混杂；R2 图片能力在文档和类型中存在，但运行链路已经删除。项目需要恢复“声明的架构等于可验证实现”的基本约束。

## What Changes

- 对 R2 图片能力作出明确收敛：只保留能够端到端运行并验证的实现，否则删除绑定、接口、路由和文档承诺。
- 统一使用 pnpm，清理 npm lockfile 和与项目运行无关的本地工具依赖污染。
- 添加最小业务测试，覆盖合并、primary 保护、鉴权和同步输入等高风险逻辑。
- 添加 TypeScript 类型检查、Wrangler dry-run 和部署前静态检查。
- CI 使用锁定版本和 frozen lockfile，在检查未通过时禁止部署。
- 更新 README、设计文档和运行配置，使其只描述真实存在的能力。

## Capabilities

### New Capabilities

- `project-quality-gates`: 包管理一致性、测试、类型检查、构建验证、架构文档一致性和死能力清理。

### Modified Capabilities

无。

## Impact

影响根目录 package 配置、pnpm lockfile、Worker 配置、R2 相关模块、测试文件、CI 和项目文档。不会引入与当前规模不匹配的测试框架或通用抽象。
