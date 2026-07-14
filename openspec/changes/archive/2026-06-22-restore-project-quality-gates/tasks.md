## 1. 包管理与类型

- [x] 1.1 固定 pnpm 版本并同步唯一 lockfile
- [x] 1.2 移除 npm lockfile 和不属于产品的根运行依赖
- [x] 1.3 添加 TypeScript 与 Wrangler 生成的 Env 类型

## 2. 架构清理

- [x] 2.1 确认图片策略并删除或恢复 R2 端到端链路
- [x] 2.2 删除未使用接口、绑定、路由和失真的数据字段
- [x] 2.3 更新 README、设计文档和配置以反映真实能力

## 3. 最小质量门

- [x] 3.1 添加合并与 primary 失败保护测试
- [x] 3.2 添加管理鉴权和同步输入测试
- [x] 3.3 添加 `test`、`typecheck` 和 `build:check` 脚本
- [x] 3.4 在 CI 中使用 frozen lockfile 并按顺序运行所有检查
