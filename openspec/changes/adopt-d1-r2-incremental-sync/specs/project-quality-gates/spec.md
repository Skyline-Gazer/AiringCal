## ADDED Requirements

### Requirement: D1 与 R2 发布链路必须自动验证
质量门禁 MUST 覆盖 migration、稳定 hash、零变化零写入、两次删除确认、原子预算与 R2 pointer 最后切换。

#### Scenario: 重放相同每日同步
- **WHEN** 测试以相同输入连续运行两次
- **THEN** 第二次不写 collection row、R2 snapshot 或 KV pointer

### Requirement: 部署配置必须解析全部状态资源
CI MUST 验证 D1 ID materialization、两个 R2 bucket bindings 与 migration-before-deploy 顺序。

#### Scenario: D1 placeholder 未替换
- **WHEN** dry-run config 仍包含 D1 database ID placeholder
- **THEN** 配置检查失败且不运行 Worker deploy
